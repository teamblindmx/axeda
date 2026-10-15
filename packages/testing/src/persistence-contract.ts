import {
  GLOBAL_SCOPE,
  isAxedaError,
  isTransactional,
  parsePermissionKey,
  type AxedaPersistence,
  type NewRole,
} from '@axeda/core';
import { beforeEach, describe, expect, it } from 'vitest';

export type PersistenceFactory = () => AxedaPersistence | Promise<AxedaPersistence>;

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
      db = await create();
    });

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
