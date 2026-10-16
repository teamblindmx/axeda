import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SCOPE,
  isAxedaError,
  type Actor,
  type AssignmentScope,
  type PermissionKey,
  type TargetScope,
} from '../src/index.js';
import { createFixture, type Fixture } from './fixture.js';

/**
 * Ley de seguridad central: **nadie obtiene, por ninguna secuencia de operaciones de la API,
 * más poder del que ya tenían los usuarios con que se empezó.**
 *
 * Se parte de dos usuarios con poder acotado (A, administrador de la compañía X, y M, gestor de
 * funciones y asignaciones global) y tres sin ninguno. Se lanzan al azar operaciones de todos
 * ellos (asignar, revocar, crear/editar/desactivar/borrar funciones) y, tras cada una, se
 * comprueba que los permisos efectivos de cualquiera, en cualquier alcance, siguen cubiertos por
 * el techo inicial. No se mira cómo está implementada la regla: solo el resultado.
 */

const COMPANY_X: AssignmentScope = { type: 'company', id: 'X' };
const SCOPES: AssignmentScope[] = [
  GLOBAL_SCOPE,
  COMPANY_X,
  { type: 'company', id: 'Y' },
  { type: 'business', id: 'bx' }, // de la compañía X
  { type: 'business', id: 'by' }, // de la compañía Y
];
const TARGETS: TargetScope[] = [
  { type: 'global' },
  { type: 'company', companyId: 'X' },
  { type: 'company', companyId: 'Y' },
  { type: 'business', companyId: 'X', businessId: 'bx' },
  { type: 'business', companyId: 'Y', businessId: 'by' },
];
const USERS = ['A', 'M', 'B', 'C'] as const;
const ROLE_KEYS = [
  'viewer',
  'editor',
  'deleter',
  'invoice-all',
  'reporter',
  'role-admin',
  'assign-admin',
  'company-admin',
  'manager',
] as const;
const PERMISSIONS = [
  'invoice:read',
  'invoice:create',
  'invoice:update',
  'invoice:delete',
  'report:read',
  'invoice:*',
  'axeda:role:manage',
  'axeda:assignment:manage',
  '*',
];

const stats = { granted: 0, denied: 0, roleChanges: 0 };

async function build(): Promise<Fixture & { actors: Record<string, Actor>; roleIds: string[] }> {
  const f = await createFixture(undefined, {
    scopes: { companyOfBusiness: async (id) => ({ bx: 'X', by: 'Y' })[id] ?? null },
  });
  await f.role('viewer', ['invoice:read']);
  await f.role('editor', ['invoice:read', 'invoice:update']);
  await f.role('deleter', ['invoice:delete']);
  await f.role('invoice-all', ['invoice:*']);
  await f.role('reporter', ['report:read']);
  await f.role('role-admin', ['axeda:role:manage']);
  await f.role('assign-admin', ['axeda:assignment:manage']);
  await f.role('company-admin', ['axeda:assignment:manage', 'invoice:read']);
  await f.role('manager', ['axeda:role:manage', 'axeda:assignment:manage', 'invoice:read']);

  const actors = Object.fromEntries(USERS.map((id) => [id, f.user(id)])) as Record<string, Actor>;
  await f.give('A', 'company-admin', COMPANY_X);
  await f.give('M', 'manager', GLOBAL_SCOPE);
  const roleIds = await Promise.all(
    ROLE_KEYS.map(async (key) => (await f.persistence.roles.getByKey(key))?.id ?? ''),
  );
  return { ...f, actors, roleIds };
}

type Op =
  | { kind: 'assign'; actor: number; user: number; role: number; scope: number }
  | { kind: 'revoke'; actor: number; pick: number }
  | { kind: 'create'; actor: number; permissions: number[]; n: number }
  | { kind: 'update'; actor: number; role: number; permissions: number[] }
  | { kind: 'status'; actor: number; role: number; active: boolean }
  | { kind: 'delete'; actor: number; role: number };

const idx = (max: number) => fc.nat({ max: max - 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('assign' as const),
      actor: idx(USERS.length),
      user: idx(USERS.length),
      role: idx(ROLE_KEYS.length),
      scope: idx(SCOPES.length),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('revoke' as const),
      actor: idx(USERS.length),
      pick: fc.nat({ max: 50 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      actor: idx(USERS.length),
      permissions: fc.array(idx(PERMISSIONS.length), { minLength: 1, maxLength: 3 }),
      n: fc.nat({ max: 5 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('update' as const),
      actor: idx(USERS.length),
      role: idx(ROLE_KEYS.length),
      permissions: fc.array(idx(PERMISSIONS.length), { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('status' as const),
      actor: idx(USERS.length),
      role: idx(ROLE_KEYS.length),
      active: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('delete' as const),
      actor: idx(USERS.length),
      role: idx(ROLE_KEYS.length),
    }),
  },
);

type World = Awaited<ReturnType<typeof build>>;

const permissionsOf = (numbers: number[]): string[] =>
  numbers.map((n) => PERMISSIONS[n] ?? 'invoice:read');

/** Cada operación como una función que devuelve la promesa de la llamada real a la API. */
const handlers: {
  [K in Op['kind']]: (f: World, actor: Actor, op: Extract<Op, { kind: K }>) => Promise<unknown>;
} = {
  assign: (f, actor, op) =>
    f.axeda.assignments.assign(actor, {
      userId: USERS[op.user] ?? 'B',
      roleId: f.roleIds[op.role] ?? '',
      scope: SCOPES[op.scope] ?? GLOBAL_SCOPE,
    }),
  revoke: async (f, actor, op) => {
    const all = (
      await Promise.all(USERS.map((id) => f.persistence.assignments.listForUser(id)))
    ).flat();
    const target = all[op.pick % Math.max(all.length, 1)];
    return f.axeda.assignments.revoke(actor, target?.id ?? 'none');
  },
  create: (f, actor, op) =>
    f.axeda.roles.create(actor, {
      key: `r${op.n}`,
      name: 'random',
      permissions: permissionsOf(op.permissions),
    }),
  update: async (f, actor, op) => {
    const id = f.roleIds[op.role] ?? '';
    const role = await f.persistence.roles.get(id);
    return f.axeda.roles.update(actor, id, role?.version ?? 0, {
      permissions: permissionsOf(op.permissions),
    });
  },
  status: async (f, actor, op) => {
    const id = f.roleIds[op.role] ?? '';
    const role = await f.persistence.roles.get(id);
    return f.axeda.roles.setStatus(
      actor,
      id,
      role?.version ?? 0,
      op.active ? 'active' : 'inactive',
    );
  },
  delete: (f, actor, op) => f.axeda.roles.delete(actor, f.roleIds[op.role] ?? ''),
};

async function run(f: World, op: Op): Promise<void> {
  const actor = f.actors[USERS[op.actor] ?? 'B'] as Actor;
  const handler = handlers[op.kind] as (f: World, actor: Actor, op: Op) => Promise<unknown>;
  try {
    await handler(f, actor, op);
    stats[op.kind === 'assign' || op.kind === 'revoke' ? 'granted' : 'roleChanges'] += 1;
  } catch (error) {
    if (!isAxedaError(error)) throw error;
    stats.denied += 1;
  }
}

describe('privilege escalation (property)', () => {
  it('no sequence of API operations by limited users ever raises anyone above the initial ceiling', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        const f = await build();
        // Techo: lo que A y M podían hacer al principio, en cada alcance.
        const ceilings = await Promise.all(
          TARGETS.map(async (target) => ({
            target,
            keys: [
              ...(await f.axeda.effectivePermissions(f.actors['A'] as Actor, target)).keys,
              ...(await f.axeda.effectivePermissions(f.actors['M'] as Actor, target)).keys,
            ],
          })),
        );
        const within = (keys: readonly PermissionKey[], ceiling: readonly PermissionKey[]) =>
          keys.every((key) =>
            ceiling.some(
              (held) => held === key || (held.endsWith('*') && key.startsWith(held.slice(0, -1))),
            ),
          );

        for (const op of ops) {
          await run(f, op);
          for (const user of USERS) {
            for (const { target, keys: ceiling } of ceilings) {
              const effective = (
                await f.axeda.effectivePermissions(f.actors[user] as Actor, target)
              ).keys;
              expect(
                within(effective, ceiling),
                `${user} at ${JSON.stringify(target)} holds ${effective.join(', ')}`,
              ).toBe(true);
            }
          }
        }
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it('is not vacuous: the generator really exercises grants, denials and role edits', () => {
    expect(stats.granted).toBeGreaterThan(50);
    expect(stats.denied).toBeGreaterThan(200);
    expect(stats.roleChanges).toBeGreaterThan(20);
  });
});
