import {
  GLOBAL_SCOPE,
  isAxedaError,
  isTransactional,
  parsePermissionKey,
  type AuditFilter,
  type AxedaPersistence,
  type NewAuditEvent,
  type NewRole,
} from '@teamblind/axeda-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineTenantContract } from './tenant-contract.js';

/**
 * Usuarios que la suite usa. Las persistencias respaldadas por una base con claves foráneas
 * (Better Auth) deben tenerlos creados antes de empezar; la de memoria los ignora.
 */
export const CONTRACT_USERS: readonly string[] = ['u1', 'u2'];

export type PersistenceFactory = (
  users: readonly string[],
) => AxedaPersistence | Promise<AxedaPersistence>;

const perms = (...keys: string[]) => keys.map(parsePermissionKey);

export const roleInput = (overrides: Partial<NewRole> = {}): NewRole => ({
  key: 'cashier',
  name: 'Cashier',
  permissions: perms('invoice:create', 'invoice:read'),
  ...overrides,
});

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code as never), `expected ${code}, got ${String(error)}`).toBe(true);
};

/**
 * Suite de contrato de los puertos de persistencia de Axeda. Toda implementación (memoria,
 * Better Auth sobre SQLite o PostgreSQL, …) debe pasarla entera.
 */
export function runPersistenceContract(name: string, create: PersistenceFactory): void {
  describe(`persistence contract: ${name}`, () => {
    let db: AxedaPersistence;
    beforeEach(async () => {
      db = await create(CONTRACT_USERS);
    });

    defineTenantContract(() => db);

    describe('roles', () => {
      it('creates a role with defaults and reads it back by id and by key', async () => {
        const role = await db.roles.create(roleInput());
        expect(role).toMatchObject({
          key: 'cashier',
          status: 'active',
          requireMfa: false,
          managed: false,
          version: 1,
          description: null,
        });
        expect(await db.roles.get(role.id)).toEqual(role);
        expect(await db.roles.getByKey('cashier')).toEqual(role);
      });

      it('returns null for unknown roles', async () => {
        expect(await db.roles.get('nope')).toBeNull();
        expect(await db.roles.getByKey('nope')).toBeNull();
      });

      it('rejects a duplicate key', async () => {
        await db.roles.create(roleInput());
        await expectCode(db.roles.create(roleInput()), 'AXEDA_ROLE_KEY_TAKEN');
      });

      it('lets exactly one of two concurrent creations of the same key win', async () => {
        const results = await Promise.allSettled([
          db.roles.create(roleInput({ key: 'race' })),
          db.roles.create(roleInput({ key: 'race' })),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          isAxedaError(
            rejected?.status === 'rejected' ? rejected.reason : null,
            'AXEDA_ROLE_KEY_TAKEN',
          ),
        ).toBe(true);
        expect((await db.roles.list({ limit: 10 })).items).toHaveLength(1);
      });

      it('getMany returns only the roles that exist', async () => {
        const a = await db.roles.create(roleInput({ key: 'a' }));
        const b = await db.roles.create(roleInput({ key: 'b' }));
        const found = await db.roles.getMany([a.id, 'missing', b.id]);
        expect(found.map((role) => role.key).sort()).toEqual(['a', 'b']);
        expect(await db.roles.getMany([])).toEqual([]);
      });

      it('updates with the expected version and bumps it', async () => {
        const role = await db.roles.create(roleInput());
        const updated = await db.roles.update(role.id, 1, {
          name: 'Senior cashier',
          permissions: perms('invoice:*'),
          requireMfa: true,
          status: 'inactive',
        });
        expect(updated).toMatchObject({
          name: 'Senior cashier',
          requireMfa: true,
          status: 'inactive',
          version: 2,
        });
        expect(updated.permissions).toEqual(perms('invoice:*'));
        expect(updated.key).toBe('cashier');
      });

      it('keeps unspecified fields and can clear the description', async () => {
        const role = await db.roles.create(roleInput({ description: 'front desk' }));
        const kept = await db.roles.update(role.id, 1, { name: 'Renamed' });
        expect(kept.description).toBe('front desk');
        const cleared = await db.roles.update(role.id, 2, { description: null });
        expect(cleared.description).toBeNull();
      });

      it('rejects a stale version (optimistic concurrency)', async () => {
        const role = await db.roles.create(roleInput());
        await db.roles.update(role.id, 1, { name: 'first writer' });
        await expectCode(
          db.roles.update(role.id, 1, { name: 'second writer' }),
          'AXEDA_VERSION_CONFLICT',
        );
        expect((await db.roles.get(role.id))?.name).toBe('first writer');
      });

      it('rejects updating a role that does not exist', async () => {
        await expectCode(db.roles.update('nope', 1, { name: 'x' }), 'AXEDA_ROLE_NOT_FOUND');
      });

      it('lists roles in key order with cursor pagination', async () => {
        for (const key of ['d', 'a', 'c', 'b', 'e']) await db.roles.create(roleInput({ key }));
        const first = await db.roles.list({ limit: 2 });
        expect(first.items.map((role) => role.key)).toEqual(['a', 'b']);
        expect(first.nextCursor).not.toBeNull();
        const second = await db.roles.list({ limit: 2, cursor: first.nextCursor ?? '' });
        expect(second.items.map((role) => role.key)).toEqual(['c', 'd']);
        const third = await db.roles.list({ limit: 2, cursor: second.nextCursor ?? '' });
        expect(third.items.map((role) => role.key)).toEqual(['e']);
        expect(third.nextCursor).toBeNull();
      });

      it('does not return a cursor when everything fits in one page', async () => {
        await db.roles.create(roleInput());
        const page = await db.roles.list({ limit: 10 });
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toBeNull();
      });

      it('deletes a role together with its assignments', async () => {
        const role = await db.roles.create(roleInput());
        await db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
        expect(await db.roles.delete(role.id)).toBe(true);
        expect(await db.roles.get(role.id)).toBeNull();
        expect(await db.assignments.listForUser('u1')).toEqual([]);
        expect(await db.roles.delete(role.id)).toBe(false);
      });
    });

    describe('assignments', () => {
      it('creates and lists assignments with their scope and expiry', async () => {
        const role = await db.roles.create(roleInput());
        const expiresAt = new Date('2030-01-01T00:00:00.000Z');
        const created = await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'company', id: 'c1' },
          grantedBy: 'admin',
          expiresAt,
        });
        expect(created).toMatchObject({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'company', id: 'c1' },
          grantedBy: 'admin',
        });
        expect(created.expiresAt?.getTime()).toBe(expiresAt.getTime());
        expect(await db.assignments.listForUser('u1')).toHaveLength(1);
        expect(await db.assignments.countForUser('u1')).toBe(1);
      });

      it('defaults grantedBy and expiresAt to null', async () => {
        const role = await db.roles.create(roleInput());
        const created = await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: GLOBAL_SCOPE,
        });
        expect(created.grantedBy).toBeNull();
        expect(created.expiresAt).toBeNull();
      });

      it('rejects the same role in the same scope twice, but allows it in another scope', async () => {
        const role = await db.roles.create(roleInput());
        await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'company', id: 'c1' },
        });
        await expectCode(
          db.assignments.create({
            userId: 'u1',
            roleId: role.id,
            scope: { type: 'company', id: 'c1' },
          }),
          'AXEDA_ASSIGNMENT_EXISTS',
        );
        await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'company', id: 'c2' },
        });
        await db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
        expect(await db.assignments.countForUser('u1')).toBe(3);
      });

      it('lets exactly one of two concurrent identical assignments win', async () => {
        const role = await db.roles.create(roleInput());
        const results = await Promise.allSettled([
          db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE }),
          db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          isAxedaError(
            rejected?.status === 'rejected' ? rejected.reason : null,
            'AXEDA_ASSIGNMENT_EXISTS',
          ),
        ).toBe(true);
        expect(await db.assignments.countForUser('u1')).toBe(1);
      });

      it('rejects an assignment to a role that does not exist', async () => {
        await expectCode(
          db.assignments.create({ userId: 'u1', roleId: 'missing', scope: GLOBAL_SCOPE }),
          'AXEDA_ROLE_NOT_FOUND',
        );
      });

      it('keeps users apart', async () => {
        const role = await db.roles.create(roleInput());
        await db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
        await db.assignments.create({ userId: 'u2', roleId: role.id, scope: GLOBAL_SCOPE });
        expect(await db.assignments.countForUser('u1')).toBe(1);
        expect(await db.assignments.countForUser('nobody')).toBe(0);
        expect(await db.assignments.listForUser('nobody')).toEqual([]);
      });

      it('revokes one assignment', async () => {
        const role = await db.roles.create(roleInput());
        const created = await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: GLOBAL_SCOPE,
        });
        expect(await db.assignments.revoke(created.id)).toBe(true);
        expect(await db.assignments.revoke(created.id)).toBe(false);
        expect(await db.assignments.countForUser('u1')).toBe(0);
      });

      it('deletes every assignment of a user and reports how many', async () => {
        const role = await db.roles.create(roleInput());
        await db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
        await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'company', id: 'c1' },
        });
        await db.assignments.create({ userId: 'u2', roleId: role.id, scope: GLOBAL_SCOPE });
        expect(await db.assignments.deleteForUser('u1')).toBe(2);
        expect(await db.assignments.countForUser('u1')).toBe(0);
        expect(await db.assignments.countForUser('u2')).toBe(1);
        expect(await db.assignments.deleteForUser('u1')).toBe(0);
      });
    });

    describe('assignment lookups', () => {
      it('gets an assignment by id, or null', async () => {
        const role = await db.roles.create(roleInput());
        const created = await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'business', id: 'b1' },
          grantedBy: 'admin',
        });
        expect(await db.assignments.get(created.id)).toEqual(created);
        expect(await db.assignments.get('missing')).toBeNull();
      });

      it('lists only the assignments of exactly one scope, with cursor pagination', async () => {
        const role = await db.roles.create(roleInput());
        const inA = { type: 'company', id: 'A' } as const;
        await db.assignments.create({ userId: 'u1', roleId: role.id, scope: inA });
        await db.assignments.create({ userId: 'u2', roleId: role.id, scope: inA });
        await db.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
        await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'company', id: 'B' },
        });
        await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'business', id: 'A' },
        });

        const first = await db.assignments.listForScope(inA, { limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).not.toBeNull();
        const second = await db.assignments.listForScope(inA, {
          limit: 1,
          cursor: first.nextCursor ?? '',
        });
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        const users = [...first.items, ...second.items].map((item) => item.userId).sort();
        expect(users).toEqual(['u1', 'u2']);

        const global = await db.assignments.listForScope(GLOBAL_SCOPE, { limit: 10 });
        expect(global.items).toHaveLength(1);
        expect(
          (await db.assignments.listForScope({ type: 'company', id: 'none' }, { limit: 10 })).items,
        ).toEqual([]);
      });
    });

    describe('audit', () => {
      const event = (overrides: Partial<NewAuditEvent> = {}): NewAuditEvent => ({
        actorId: 'admin',
        action: 'assignment.create',
        targetType: 'assignment',
        targetId: 'x',
        scope: null,
        outcome: 'success',
        ip: null,
        userAgent: null,
        metadata: {},
        ...overrides,
      });

      it('appends an event and returns it with an id and a timestamp', async () => {
        const stored = await db.audit.append(
          event({
            scope: { type: 'company', id: 'A' },
            ip: '203.0.113.7',
            userAgent: 'curl/8',
            metadata: { roleKey: 'cashier', nested: { ok: true }, list: [1, 'two'] },
          }),
        );
        expect(stored.id).toEqual(expect.any(String));
        expect(stored.at).toBeInstanceOf(Date);
        expect(stored).toMatchObject({
          actorId: 'admin',
          action: 'assignment.create',
          scope: { type: 'company', id: 'A' },
          ip: '203.0.113.7',
          userAgent: 'curl/8',
          metadata: { roleKey: 'cashier', nested: { ok: true }, list: [1, 'two'] },
        });
        expect((await db.audit.list({}, { limit: 10 })).items).toEqual([stored]);
      });

      it('keeps system events (no actor) and a global scope', async () => {
        const stored = await db.audit.append(
          event({
            actorId: null,
            action: 'bootstrap',
            targetType: 'system',
            targetId: null,
            scope: GLOBAL_SCOPE,
          }),
        );
        const [read] = (await db.audit.list({}, { limit: 10 })).items;
        expect(read).toEqual(stored);
        expect(read?.actorId).toBeNull();
        expect(read?.scope).toEqual(GLOBAL_SCOPE);
      });

      it('lists the newest first and paginates without gaps or repeats', async () => {
        const ids: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          ids.push((await db.audit.append(event({ targetId: String(index) }))).id);
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await db.audit.list({}, { limit: 2, ...(cursor ? { cursor } : {}) });
          seen.push(...page.items.map((item) => item.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(seen).toEqual([...ids].reverse());
      });

      it('filters by actor, action, target and scope', async () => {
        await db.audit.append(event({ actorId: 'a1', action: 'role.create', targetType: 'role' }));
        await db.audit.append(event({ actorId: 'a2', scope: { type: 'company', id: 'A' } }));
        await db.audit.append(event({ actorId: 'a2', scope: { type: 'company', id: 'B' } }));
        await db.audit.append(event({ actorId: 'a2', targetId: 'needle' }));
        const count = async (filter: AuditFilter) =>
          (await db.audit.list(filter, { limit: 50 })).items.length;

        expect(await count({ actorId: 'a2' })).toBe(3);
        expect(await count({ action: 'role.create' })).toBe(1);
        expect(await count({ targetType: 'role' })).toBe(1);
        expect(await count({ targetId: 'needle' })).toBe(1);
        expect(await count({ scope: { type: 'company', id: 'A' } })).toBe(1);
        expect(await count({ actorId: 'a2', scope: { type: 'company', id: 'B' } })).toBe(1);
        expect(await count({ actorId: 'nobody' })).toBe(0);
        expect(await count({})).toBe(4);
      });

      it('is rolled back with the transaction that wrote it', async () => {
        await expect(
          db.transaction(async (tx) => {
            await tx.audit.append(event());
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect((await db.audit.list({}, { limit: 10 })).items).toEqual([]);
        await db.transaction((tx) => tx.audit.append(event()));
        expect((await db.audit.list({}, { limit: 10 })).items).toHaveLength(1);
      });
    });

    describe('authorization versions', () => {
      it('starts at zero and increments', async () => {
        expect(await db.authz.getPolicyVersion()).toBe(0);
        expect(await db.authz.getUserVersion('u1')).toBe(0);
        expect(await db.authz.bumpPolicyVersion()).toBe(1);
        expect(await db.authz.bumpUserVersion('u1')).toBe(1);
        expect(await db.authz.bumpUserVersion('u1')).toBe(2);
        expect(await db.authz.getUserVersion('u1')).toBe(2);
        expect(await db.authz.getUserVersion('u2')).toBe(0);
      });

      it('never loses a concurrent increment (50 of 50)', async () => {
        await Promise.all(Array.from({ length: 50 }, () => db.authz.bumpUserVersion('u1')));
        await Promise.all(Array.from({ length: 50 }, () => db.authz.bumpPolicyVersion()));
        expect(await db.authz.getUserVersion('u1')).toBe(50);
        expect(await db.authz.getPolicyVersion()).toBe(50);
      });
    });

    describe('transactions', () => {
      it('commits every write and returns the callback value', async () => {
        const result = await db.transaction(async (tx) => {
          const role = await tx.roles.create(roleInput());
          await tx.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
          await tx.authz.bumpUserVersion('u1');
          return role.key;
        });
        expect(result).toBe('cashier');
        expect(await db.assignments.countForUser('u1')).toBe(1);
        expect(await db.authz.getUserVersion('u1')).toBe(1);
      });

      it('rolls back every write when the callback throws, and rethrows the same error', async () => {
        const role = await db.roles.create(roleInput({ key: 'kept' }));
        const failure = new Error('boom');
        await expect(
          db.transaction(async (tx) => {
            await tx.roles.create(roleInput({ key: 'discarded' }));
            await tx.assignments.create({ userId: 'u1', roleId: role.id, scope: GLOBAL_SCOPE });
            await tx.authz.bumpUserVersion('u1');
            await tx.authz.bumpPolicyVersion();
            throw failure;
          }),
        ).rejects.toBe(failure);

        expect(await db.roles.getByKey('discarded')).toBeNull();
        expect(await db.roles.getByKey('kept')).not.toBeNull();
        expect(await db.assignments.countForUser('u1')).toBe(0);
        expect(await db.authz.getUserVersion('u1')).toBe(0);
        expect(await db.authz.getPolicyVersion()).toBe(0);
      });

      it('rolls back when a store error aborts the transaction midway', async () => {
        await db.roles.create(roleInput({ key: 'taken' }));
        await expectCode(
          db.transaction(async (tx) => {
            await tx.authz.bumpPolicyVersion();
            await tx.roles.create(roleInput({ key: 'taken' }));
          }),
          'AXEDA_ROLE_KEY_TAKEN',
        );
        expect(await db.authz.getPolicyVersion()).toBe(0);
      });

      it('keeps working after a rolled-back transaction', async () => {
        await expect(
          db.transaction(async () => {
            throw new Error('first');
          }),
        ).rejects.toThrow('first');
        await db.roles.create(roleInput());
        expect(await db.roles.getByKey('cashier')).not.toBeNull();
      });

      it('passes the startup self-test that Axeda runs before serving requests', async () => {
        expect(await isTransactional(db)).toBe(true);
        expect((await db.roles.list({ limit: 100 })).items).toEqual([]);
        expect(await db.authz.getPolicyVersion()).toBe(0);
      });
    });
  });
}
