import { isAxedaError, type AxedaPersistence, type NewStaffAccount } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const policy = { maxAttempts: 3, lockMs: 15 * 60_000 };

const account = (overrides: Partial<NewStaffAccount> = {}): NewStaffAccount => ({
  userId: 's1',
  companyId: 'c1',
  businessId: null,
  siteId: null,
  username: 'mesero1',
  pinHash: 'hash-1',
  createdBy: 'u1',
  ...overrides,
});

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code as never), `expected ${code}, got ${String(error)}`).toBe(true);
};

/** Pruebas de contrato de las cuentas de personal (parte de `runPersistenceContract`). */
export function defineStaffContract(database: () => AxedaPersistence): void {
  describe('staff accounts', () => {
    it('creates an account and finds it by user and by username in its company', async () => {
      const created = await database().staff.create(account({ businessId: 'b1', siteId: 'x1' }));
      expect(created).toMatchObject({
        userId: 's1',
        companyId: 'c1',
        businessId: 'b1',
        siteId: 'x1',
        username: 'mesero1',
        failedAttempts: 0,
        lockedUntil: null,
        createdBy: 'u1',
      });
      expect(created).not.toHaveProperty('pinHash');
      expect((await database().staff.get('s1'))?.pinHash).toBe('hash-1');
      expect((await database().staff.findByUsername('c1', 'mesero1'))?.userId).toBe('s1');
      expect(await database().staff.findByUsername('c2', 'mesero1')).toBeNull();
      expect(await database().staff.get('nope')).toBeNull();
    });

    it('keeps usernames unique per company, not across companies', async () => {
      await database().staff.create(account());
      await expectCode(database().staff.create(account({ userId: 's2' })), 'AXEDA_USERNAME_TAKEN');
      await database().staff.create(account({ userId: 's2', companyId: 'c2' }));
      await database().staff.create(account({ userId: 's3', username: 'cocina' }));
      await expectCode(database().staff.rename('s3', 'mesero1'), 'AXEDA_USERNAME_TAKEN');
      expect((await database().staff.rename('s3', 'cocina2')).username).toBe('cocina2');
      await expectCode(database().staff.rename('nope', 'x1x'), 'AXEDA_STAFF_NOT_FOUND');
    });

    it('lists a company, a business or a site, ordered by username, in pages', async () => {
      await database().staff.create(account({ userId: 's1', username: 'zeta' }));
      await database().staff.create(
        account({ userId: 's2', username: 'alfa', businessId: 'b1', siteId: 'x1' }),
      );
      await database().staff.create(account({ userId: 's3', username: 'beta', businessId: 'b1' }));
      const names = async (filter: Parameters<AxedaPersistence['staff']['list']>[0]) =>
        (await database().staff.list(filter, { limit: 10 })).items.map((a) => a.username);
      expect(await names({ companyId: 'c1' })).toEqual(['alfa', 'beta', 'zeta']);
      expect(await names({ companyId: 'c1', businessId: 'b1' })).toEqual(['alfa', 'beta']);
      expect(await names({ companyId: 'c1', siteId: 'x1' })).toEqual(['alfa']);
      expect(await names({ companyId: 'c2' })).toEqual([]);
      const first = await database().staff.list({ companyId: 'c1' }, { limit: 2 });
      const second = await database().staff.list(
        { companyId: 'c1' },
        { limit: 2, cursor: first.nextCursor ?? '' },
      );
      expect([...first.items, ...second.items].map((a) => a.username)).toEqual([
        'alfa',
        'beta',
        'zeta',
      ]);
      expect(second.nextCursor).toBeNull();
      for (const item of first.items) expect(item).not.toHaveProperty('pinHash');
    });

    it('spends attempts up to the limit, then locks until the lock is over', async () => {
      await database().staff.create(account());
      const spend = (at = NOW) => database().staff.consumeAttempt('s1', at, policy);
      expect([await spend(), await spend(), await spend()]).toEqual([
        'allowed',
        'allowed',
        'allowed',
      ]);
      expect(await spend()).toBe('locked');
      const locked = await database().staff.get('s1');
      expect(locked?.lockedUntil?.getTime()).toBe(NOW.getTime() + policy.lockMs);
      // Al terminar el bloqueo vuelve a tener todos sus intentos.
      const later = new Date(NOW.getTime() + policy.lockMs + 1);
      expect(await spend(later)).toBe('allowed');
      expect((await database().staff.get('s1'))?.failedAttempts).toBe(1);
    });

    it('never lets simultaneous attempts go past the limit', async () => {
      await database().staff.create(account());
      const results = await Promise.all(
        Array.from({ length: 8 }, () => database().staff.consumeAttempt('s1', NOW, policy)),
      );
      expect(results.filter((result) => result === 'allowed')).toHaveLength(3);
    });

    it('resets the attempts after a success, and a new PIN unlocks too', async () => {
      await database().staff.create(account());
      await database().staff.consumeAttempt('s1', NOW, policy);
      await database().staff.consumeAttempt('s1', NOW, policy);
      await database().staff.resetAttempts('s1');
      expect(await database().staff.get('s1')).toMatchObject({
        failedAttempts: 0,
        lockedUntil: null,
      });
      for (let i = 0; i < 4; i++) await database().staff.consumeAttempt('s1', NOW, policy);
      const at = new Date('2026-06-02T00:00:00.000Z');
      await database().staff.setPin('s1', 'hash-2', at);
      expect(await database().staff.get('s1')).toMatchObject({
        pinHash: 'hash-2',
        failedAttempts: 0,
        lockedUntil: null,
      });
      expect((await database().staff.get('s1'))?.pinChangedAt.getTime()).toBe(at.getTime());
      await expectCode(database().staff.setPin('nope', 'h', at), 'AXEDA_STAFF_NOT_FOUND');
    });

    it('deletes one account, or those of what is purged', async () => {
      await database().staff.create(account({ userId: 's1', username: 'a1a' }));
      await database().staff.create(account({ userId: 's2', username: 'b1b', businessId: 'b1' }));
      await database().staff.create(
        account({ userId: 's3', username: 'c1c', companyId: 'c2', siteId: 'x9' }),
      );
      const byBusiness = await database().staff.deleteOwnedBy({
        companyIds: [],
        businessIds: ['b1'],
        siteIds: [],
      });
      expect(byBusiness.map((a) => a.userId)).toEqual(['s2']);
      const bySite = await database().staff.deleteOwnedBy({
        companyIds: [],
        businessIds: [],
        siteIds: ['x9'],
      });
      expect(bySite.map((a) => a.userId)).toEqual(['s3']);
      expect(await database().staff.delete('s1')).toBe(true);
      expect(await database().staff.delete('s1')).toBe(false);
      expect(
        await database().staff.deleteOwnedBy({ companyIds: ['c1'], businessIds: [], siteIds: [] }),
      ).toEqual([]);
    });
  });
}
