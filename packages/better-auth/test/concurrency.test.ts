import {
  GLOBAL_SCOPE,
  createAxeda,
  isAxedaError,
  type Actor,
  type Axeda,
  type InvitationMessage,
} from '@axeda/core';
import { describe, expect, it } from 'vitest';
import { createBetterAuthPersistence, createBetterAuthUserDirectory } from '../src/index.js';
import { databaseKinds } from './support/databases.js';
import { createAuth, createUsers, type DatabaseKind } from './support/harness.js';

/**
 * Operaciones que compiten entre sí. Cada prueba afirma un invariante que debe cumplirse con
 * CUALQUIER grado de paralelismo: en SQLite y PGlite (una sola conexión) valida la lógica, y en
 * un servidor PostgreSQL con grupo de conexiones los escritores corren de verdad a la vez, que
 * es donde una carrera de «comprobar y luego insertar» se haría visible.
 */
const RUNNERS = 12;
const PERMISSIONS = ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'];

interface World {
  readonly axeda: Axeda;
  readonly admin: Actor;
  readonly sent: InvitationMessage[];
  readonly adapter: Awaited<ReturnType<typeof createAuth>>['adapter'];
}

async function world(
  kind: DatabaseKind,
  limits: { maxAssignmentsPerUser?: number } = {},
): Promise<World> {
  const { adapter } = await createAuth(kind);
  await createUsers(adapter, [
    'admin',
    'target',
    ...Array.from({ length: RUNNERS }, (_, i) => `u${i}`),
  ]);
  const sent: InvitationMessage[] = [];
  const axeda = createAxeda(
    { permissions: PERMISSIONS, limits },
    {
      persistence: createBetterAuthPersistence(adapter),
      users: createBetterAuthUserDirectory(adapter),
      invitations: { send: async (message) => void sent.push(message) },
    },
  );
  await axeda.start();
  await axeda.bootstrap({ userId: 'admin' });
  return { axeda, admin: { userId: 'admin' }, sent, adapter };
}

/** Cuántas terminaron bien y cuántas con cada código de error de Axeda. */
async function settle(promises: Array<Promise<unknown>>) {
  const results = await Promise.allSettled(promises);
  const codes: Record<string, number> = {};
  let ok = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') ok += 1;
    else {
      const code = isAxedaError(result.reason)
        ? result.reason.code
        : `UNEXPECTED: ${String(result.reason)}`;
      codes[code] = (codes[code] ?? 0) + 1;
    }
  }
  return { ok, codes };
}

const makeRoles = (w: World, count: number) =>
  Promise.all(
    Array.from({ length: count }, (_, i) =>
      w.axeda.roles.create(w.admin, {
        key: `role-${i}`,
        name: `Role ${i}`,
        permissions: ['invoice:read'],
      }),
    ),
  );

const authzVersionOf = async (w: World, id: string): Promise<number> =>
  (
    await w.adapter.findOne<{ authzVersion: number }>({
      model: 'user',
      where: [{ field: 'id', value: id }],
    })
  )?.authzVersion ?? -1;

describe.each(databaseKinds)('competing writers (%s)', (kind) => {
  it('of N edits to the same role with the same version, exactly one wins', async () => {
    const w = await world(kind);
    const role = await w.axeda.roles.create(w.admin, {
      key: 'cashier',
      name: 'Cashier',
      permissions: ['invoice:read'],
    });

    const outcome = await settle(
      Array.from({ length: RUNNERS }, (_, i) =>
        w.axeda.roles.update(w.admin, role.id, role.version, { name: `Renamed ${i}` }),
      ),
    );

    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual({ AXEDA_VERSION_CONFLICT: RUNNERS - 1 });
    expect((await w.axeda.roles.get(w.admin, role.id)).version).toBe(role.version + 1);
  });

  it('of N identical assignments, exactly one is created', async () => {
    const w = await world(kind);
    const [role] = await makeRoles(w, 1);
    const input = { userId: 'target', roleId: role?.id ?? '', scope: GLOBAL_SCOPE };

    const outcome = await settle(
      Array.from({ length: RUNNERS }, () => w.axeda.assignments.assign(w.admin, input)),
    );

    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual({ AXEDA_ASSIGNMENT_EXISTS: RUNNERS - 1 });
    expect(await w.axeda.assignments.listForUser(w.admin, 'target')).toHaveLength(1);
  });

  it('never lets a user go over the assignment limit, however many arrive at once', async () => {
    const limit = 5;
    const w = await world(kind, { maxAssignmentsPerUser: limit });
    const roles = await makeRoles(w, RUNNERS);

    const outcome = await settle(
      roles.map((role) =>
        w.axeda.assignments.assign(w.admin, {
          userId: 'target',
          roleId: role.id,
          scope: GLOBAL_SCOPE,
        }),
      ),
    );

    expect(outcome.ok).toBe(limit);
    expect(outcome.codes).toEqual({ AXEDA_LIMIT_EXCEEDED: RUNNERS - limit });
    expect(await w.axeda.assignments.listForUser(w.admin, 'target')).toHaveLength(limit);
  });

  it('loses no version bump: every committed assignment moves the user version forward', async () => {
    const w = await world(kind);
    const roles = await makeRoles(w, 8);
    const before = await authzVersionOf(w, 'target');

    const outcome = await settle(
      roles.map((role) =>
        w.axeda.assignments.assign(w.admin, {
          userId: 'target',
          roleId: role.id,
          scope: GLOBAL_SCOPE,
        }),
      ),
    );

    expect(outcome).toEqual({ ok: roles.length, codes: {} });
    // Si dos escritores leyeran la misma versión y ambos escribieran «versión + 1», faltarían subidas.
    expect((await authzVersionOf(w, 'target')) - before).toBeGreaterThanOrEqual(roles.length);
  });

  it('of N companies with the same slug, exactly one is created', async () => {
    const w = await world(kind);

    const outcome = await settle(
      Array.from({ length: RUNNERS }, () =>
        w.axeda.companies.create(w.admin, { slug: 'acme', name: 'ACME' }),
      ),
    );

    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual({ AXEDA_SLUG_TAKEN: RUNNERS - 1 });
  });

  it('of N simultaneous bootstraps on a fresh install, exactly one administrator exists', async () => {
    const { adapter } = await createAuth(kind);
    const ids = Array.from({ length: RUNNERS }, (_, i) => `u${i}`);
    await createUsers(adapter, ids);
    const axeda = createAxeda(
      { permissions: PERMISSIONS },
      {
        persistence: createBetterAuthPersistence(adapter),
        users: createBetterAuthUserDirectory(adapter),
      },
    );
    await axeda.start();

    const outcome = await settle(ids.map((userId) => axeda.bootstrap({ userId })));

    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual({ AXEDA_ALREADY_BOOTSTRAPPED: RUNNERS - 1 });
    const winners = await Promise.all(ids.map((userId) => axeda.can({ userId }, 'invoice:read')));
    expect(winners.filter(Boolean)).toHaveLength(1);
  });

  it('of N invitations sent to the same email and scope, each replaces the last: one stays valid', async () => {
    const w = await world(kind);
    const [role] = await makeRoles(w, 1);
    await w.adapter.update({
      model: 'user',
      where: [{ field: 'id', value: 'u0' }],
      update: { email: 'invited@test.dev', emailVerified: true },
    });

    const outcome = await settle(
      Array.from({ length: RUNNERS }, () =>
        w.axeda.invitations.create(w.admin, {
          email: 'invited@test.dev',
          scope: { type: 'global' },
          roleIds: [role?.id ?? ''],
        }),
      ),
    );

    // Reenviar sustituye a la anterior, así que todas se envían…
    expect(outcome).toEqual({ ok: RUNNERS, codes: {} });
    expect(w.sent).toHaveLength(RUNNERS);
    // …pero queda UNA vigente en la base de datos…
    const pending = await w.axeda.invitations.list(
      w.admin,
      { type: 'global' },
      { pendingOnly: true },
      { limit: 50 },
    );
    expect(pending.items).toHaveLength(1);
    // …y de los N secretos entregados solo sirve uno.
    const accepted = await settle(
      w.sent.map((message) => w.axeda.invitations.accept({ userId: 'u0' }, message.token)),
    );
    expect(accepted.ok).toBe(1);
    expect(accepted.codes).toEqual({ AXEDA_INVITATION_INVALID: RUNNERS - 1 });
  });

  it('an invitation accepted N times at once is used exactly once', async () => {
    const w = await world(kind);
    const [role] = await makeRoles(w, 1);
    await w.adapter.update({
      model: 'user',
      where: [{ field: 'id', value: 'u0' }],
      update: { email: 'invited@test.dev', emailVerified: true },
    });
    await w.axeda.invitations.create(w.admin, {
      email: 'invited@test.dev',
      scope: { type: 'global' },
      roleIds: [role?.id ?? ''],
    });
    const token = w.sent[0]?.token ?? '';

    const outcome = await settle(
      Array.from({ length: RUNNERS }, () => w.axeda.invitations.accept({ userId: 'u0' }, token)),
    );

    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual({ AXEDA_INVITATION_INVALID: RUNNERS - 1 });
    expect(await w.axeda.assignments.listForUser(w.admin, 'u0')).toHaveLength(1);
  });

  it('a revoked permission is denied the moment the revoke returns, even with readers in flight', async () => {
    const w = await world(kind);
    const [role] = await makeRoles(w, 1);
    const assignment = await w.axeda.assignments.assign(w.admin, {
      userId: 'target',
      roleId: role?.id ?? '',
      scope: GLOBAL_SCOPE,
    });
    expect(await w.axeda.can({ userId: 'target' }, 'invoice:read')).toBe(true);

    const readers = Array.from({ length: RUNNERS }, () =>
      w.axeda.can({ userId: 'target' }, 'invoice:read'),
    );
    await w.axeda.assignments.revoke(w.admin, assignment.id);
    await Promise.all(readers);

    // Lo que importa: tras volver `revoke`, ninguna lectura nueva ve el permiso.
    const after = await Promise.all(
      Array.from({ length: RUNNERS }, () => w.axeda.can({ userId: 'target' }, 'invoice:read')),
    );
    expect(after.every((allowed) => !allowed)).toBe(true);
  });
});
