import { describe, expect, it } from 'vitest';
import {
  isAxedaError,
  isStaffEmail,
  isWeakPin,
  type Actor,
  type AxedaErrorCode,
  type StaffInput,
} from '../src/index.js';
import { createFixture } from './fixture.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error & { details: Record<string, unknown> };
};

/** Un restaurante: la compañía A con el negocio «shop» (sede «north») y la sede directa «hq». */
async function world() {
  const f = await createFixture();
  await f.company('A');
  await f.company('B');
  await f.business('shop', 'A');
  await f.site('north', 'A', 'shop');
  await f.site('hq', 'A');
  await f.role('owner', ['axeda:staff:manage', 'invoice:*']);
  await f.role('manager', ['axeda:staff:manage', 'invoice:read', 'invoice:create']);
  const waiter = await f.role('waiter', ['invoice:read', 'invoice:create']);
  const adminRole = await f.role('admin-ish', ['invoice:read', 'axeda:assignment:manage']);
  const owner = f.user('owner');
  await f.give('owner', 'owner', { type: 'company', id: 'A' });
  const manager = f.user('manager');
  await f.give('manager', 'manager', { type: 'business', id: 'shop' });

  const hire = (actor: Actor, input: Partial<StaffInput> = {}) =>
    f.axeda.staff.create(actor, {
      scope: { type: 'business', id: 'shop' },
      username: 'mesero1',
      name: 'Mesero Uno',
      roleIds: [waiter.id],
      ...input,
    });
  const signIn = (username: string, pin: string, company = 'a') =>
    f.axeda.staff.signIn({ company, username, pin });
  return { ...f, waiter, adminRole, owner, manager, hire, signIn };
}

describe('creating staff accounts', () => {
  it('creates a user with a random PIN shown once, a placeholder email and its roles', async () => {
    const w = await world();
    const { member, pin } = await w.hire(w.owner);
    expect(pin).toMatch(/^\d{6}$/);
    expect(isWeakPin(pin)).toBe(false);
    expect(member).toMatchObject({
      companyId: 'A',
      businessId: 'shop',
      siteId: null,
      username: 'mesero1',
      name: 'Mesero Uno',
      banned: false,
      failedAttempts: 0,
      lockedUntil: null,
      createdBy: 'owner',
    });
    expect(member).not.toHaveProperty('pinHash');
    expect(JSON.stringify(member)).not.toContain(pin);
    const user = await w.users.get(member.userId);
    expect(isStaffEmail(user?.email ?? '')).toBe(true);
    expect(
      await w.axeda.can({ userId: member.userId }, 'invoice:create', {
        type: 'business',
        companyId: 'A',
        businessId: 'shop',
      }),
    ).toBe(true);
    const events = await w.axeda.listAudit(w.admin, { action: 'staff.create' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({ actorId: 'owner', targetId: member.userId });
    expect(JSON.stringify(events.items)).not.toContain(pin);
  });

  it('keeps usernames unique per company, ignoring case and spaces', async () => {
    const w = await world();
    await w.hire(w.owner);
    await rejectsWith(w.hire(w.owner, { username: ' MESERO1 ' }), 'AXEDA_USERNAME_TAKEN');
    await rejectsWith(
      w.hire(w.owner, { username: 'mesero1', scope: { type: 'site', id: 'hq' } }),
      'AXEDA_USERNAME_TAKEN',
    );
    // Otra compañía puede tener el suyo.
    await w.give('owner', 'owner', { type: 'company', id: 'B' });
    await w.hire(w.owner, { scope: { type: 'company', id: 'B' }, roleIds: [] });
  });

  it('never gives a staff account a role with Axeda permissions, and leaves no user behind', async () => {
    const w = await world();
    const before = (await w.users.list({}, { limit: 100 })).items.length;
    const denied = await rejectsWith(
      w.hire(w.owner, { roleIds: [w.adminRole.id] }),
      'AXEDA_FORBIDDEN',
    );
    expect(denied.details).toMatchObject({ reason: 'pin_account_cannot_administer' });
    expect((await w.users.list({}, { limit: 100 })).items.length).toBe(before);
    expect(await w.persistence.staff.findByUsername('A', 'mesero1')).toBeNull();
  });

  it('only lets someone create staff where they manage staff', async () => {
    const w = await world();
    // El encargado del negocio: en su negocio y en sus sedes, no en la sede directa ni en la compañía.
    await w.hire(w.manager);
    await w.hire(w.manager, { username: 'cocina1', scope: { type: 'site', id: 'north' } });
    await rejectsWith(
      w.hire(w.manager, { username: 'x1x', scope: { type: 'site', id: 'hq' } }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      w.hire(w.manager, { username: 'x2x', scope: { type: 'company', id: 'A' } }),
      'AXEDA_FORBIDDEN',
    );
    const nobody = w.user('nobody');
    await rejectsWith(w.hire(nobody, { username: 'x3x' }), 'AXEDA_FORBIDDEN');
  });

  it('validates the input after checking the permission', async () => {
    const w = await world();
    for (const username of ['ab', 'ana perez', '-x-', 'a'.repeat(40)]) {
      await rejectsWith(w.hire(w.owner, { username }), 'AXEDA_INVALID_INPUT');
    }
    await rejectsWith(w.hire(w.owner, { name: '  ' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(w.hire(w.owner, { scope: { type: 'global' } }), 'AXEDA_FORBIDDEN');
  });
});

describe('managing staff', () => {
  it('lists by place: the company sees all, a business its own and its sites, a site its own', async () => {
    const w = await world();
    await w.hire(w.owner, { username: 'shop1' });
    await w.hire(w.owner, { username: 'north1', scope: { type: 'site', id: 'north' } });
    await w.hire(w.owner, { username: 'hq1', scope: { type: 'site', id: 'hq' } });
    await w.hire(w.owner, { username: 'office1', scope: { type: 'company', id: 'A' } });
    const names = async (actor: Actor, scope: StaffInput['scope']) =>
      (await w.axeda.staff.list(actor, scope, { limit: 50 })).items.map((m) => m.username);
    expect(await names(w.owner, { type: 'company', id: 'A' })).toEqual([
      'hq1',
      'north1',
      'office1',
      'shop1',
    ]);
    expect(await names(w.manager, { type: 'business', id: 'shop' })).toEqual(['north1', 'shop1']);
    expect(await names(w.manager, { type: 'site', id: 'north' })).toEqual(['north1']);
    await rejectsWith(
      w.axeda.staff.list(w.manager, { type: 'company', id: 'A' }, { limit: 5 }),
      'AXEDA_FORBIDDEN',
    );
  });

  it('hides from a manager the staff of places they do not manage', async () => {
    const w = await world();
    const { member } = await w.hire(w.owner, {
      username: 'hq1',
      scope: { type: 'site', id: 'hq' },
    });
    await rejectsWith(w.axeda.staff.get(w.manager, member.userId), 'AXEDA_STAFF_NOT_FOUND');
    await rejectsWith(w.axeda.staff.resetPin(w.manager, member.userId), 'AXEDA_STAFF_NOT_FOUND');
    await rejectsWith(w.axeda.staff.get(w.manager, 'ghost'), 'AXEDA_STAFF_NOT_FOUND');
    expect((await w.axeda.staff.get(w.owner, member.userId)).username).toBe('hq1');
  });

  it('renames, resets the PIN (closing sessions), suspends, reactivates and removes', async () => {
    const w = await world();
    const { member, pin } = await w.hire(w.manager);
    expect((await w.axeda.staff.rename(w.manager, member.userId, 'Mesera.1')).username).toBe(
      'mesera.1',
    );
    await rejectsWith(
      w.axeda.staff.rename(w.manager, member.userId, 'no way'),
      'AXEDA_INVALID_INPUT',
    );

    w.users.addSessions(member.userId, 2);
    const { pin: fresh } = await w.axeda.staff.resetPin(w.manager, member.userId);
    expect(fresh).not.toBe(pin);
    expect(w.users.sessionsOf(member.userId)).toBe(0);
    await rejectsWith(w.signIn('mesera.1', pin), 'AXEDA_STAFF_SIGN_IN_FAILED');
    expect(await w.signIn('mesera.1', fresh)).toEqual({ userId: member.userId });

    expect((await w.axeda.staff.suspend(w.manager, member.userId)).banned).toBe(true);
    await rejectsWith(w.signIn('mesera.1', fresh), 'AXEDA_STAFF_SIGN_IN_FAILED');
    expect((await w.axeda.staff.reactivate(w.manager, member.userId)).banned).toBe(false);
    expect(await w.signIn('mesera.1', fresh)).toEqual({ userId: member.userId });

    await w.axeda.staff.remove(w.manager, member.userId);
    expect(await w.users.get(member.userId)).toBeNull();
    expect(await w.persistence.staff.get(member.userId)).toBeNull();
    await rejectsWith(w.signIn('mesera.1', fresh), 'AXEDA_STAFF_SIGN_IN_FAILED');
  });
});

describe('signing in with a username and a PIN', () => {
  it('answers the same for an unknown company, an unknown user and a wrong PIN, and always hashes', async () => {
    const w = await world();
    const { pin } = await w.hire(w.owner);
    const wrong = pin === '381946' ? '519372' : '381946';
    for (const attempt of [
      () => w.signIn('mesero1', pin, 'nope'),
      () => w.signIn('nobody', pin),
      () => w.signIn('mesero1', wrong),
      () => w.signIn('mesero1', 'abc'),
    ]) {
      const error = await rejectsWith(attempt(), 'AXEDA_STAFF_SIGN_IN_FAILED');
      expect(error.message).toBe('Wrong company, username or PIN.');
    }
    // Usuario con otras mayúsculas y la compañía por su slug.
    expect((await w.signIn(' Mesero1 ', pin, 'A')).userId).toEqual(expect.any(String));
  });

  it('locks the account after five wrong PINs, even for the right one, until the lock ends', async () => {
    const w = await world();
    const { pin, member } = await w.hire(w.owner);
    const wrong = pin === '381946' ? '519372' : '381946';
    for (let i = 0; i < 5; i++)
      await rejectsWith(w.signIn('mesero1', wrong), 'AXEDA_STAFF_SIGN_IN_FAILED');
    await rejectsWith(w.signIn('mesero1', pin), 'AXEDA_STAFF_SIGN_IN_FAILED');
    expect((await w.axeda.staff.get(w.owner, member.userId)).lockedUntil).not.toBeNull();
    w.clock.current = new Date(w.clock.current.getTime() + 15 * MINUTE + 1);
    expect(await w.signIn('mesero1', pin)).toEqual({ userId: member.userId });
    const denied = await w.axeda.listAudit(w.admin, { action: 'staff.sign_in' }, { limit: 20 });
    expect(denied.items.map((event) => event.metadata['reason'] ?? event.outcome)).toContain(
      'locked',
    );
  });

  it('makes each lock in a row twice as long, so slow guessing does not pay', async () => {
    const w = await world();
    const { pin, member } = await w.hire(w.owner);
    const wrong = pin === '381946' ? '519372' : '381946';
    const lockLength = async () => {
      for (let i = 0; i < 5; i++)
        await rejectsWith(w.signIn('mesero1', wrong), 'AXEDA_STAFF_SIGN_IN_FAILED');
      const { lockedUntil } = await w.axeda.staff.get(w.owner, member.userId);
      const length = (lockedUntil?.getTime() ?? 0) - w.clock.current.getTime();
      w.clock.current = new Date((lockedUntil?.getTime() ?? 0) + 1);
      return length / MINUTE;
    };
    expect([await lockLength(), await lockLength(), await lockLength()]).toEqual([15, 30, 60]);
    expect((await w.axeda.staff.get(w.owner, member.userId)).lockCount).toBe(3);
    // Entrar bien vuelve a empezar.
    expect(await w.signIn('mesero1', pin)).toEqual({ userId: member.userId });
    expect(await lockLength()).toBe(15);
    // Por muchos seguidos, un bloqueo nunca pasa de un día.
    for (let i = 0; i < 8; i++) await lockLength();
    expect(await lockLength()).toBe(24 * 60);
  });

  it('lets five simultaneous wrong attempts through at most, and an admin unlock', async () => {
    const w = await world();
    const { pin, member } = await w.hire(w.owner);
    const wrong = pin === '381946' ? '519372' : '381946';
    await Promise.allSettled(Array.from({ length: 12 }, () => w.signIn('mesero1', wrong)));
    await rejectsWith(w.signIn('mesero1', pin), 'AXEDA_STAFF_SIGN_IN_FAILED');
    await w.axeda.staff.unlock(w.owner, member.userId);
    expect(await w.signIn('mesero1', pin)).toEqual({ userId: member.userId });
  });

  it('refuses everyone when their company, business or site is inactive', async () => {
    const w = await world();
    const { pin } = await w.hire(w.owner);
    const shop = await w.persistence.businesses.get('shop');
    await w.axeda.businesses.setStatus(w.admin, 'shop', shop?.version ?? 0, 'inactive');
    await rejectsWith(w.signIn('mesero1', pin), 'AXEDA_STAFF_SIGN_IN_FAILED');
  });

  it('lets a staff member change their own PIN, giving the current one', async () => {
    const w = await world();
    const { pin, member } = await w.hire(w.owner);
    const me = { userId: member.userId };
    const wrong = pin === '381946' ? '519372' : '381946';
    await rejectsWith(
      w.axeda.staff.changePin(me, { currentPin: wrong, newPin: '582039' }),
      'AXEDA_FORBIDDEN',
    );
    for (const newPin of ['123456', '111111', '12345', 'abcdef', pin]) {
      await rejectsWith(
        w.axeda.staff.changePin(me, { currentPin: pin, newPin }),
        'AXEDA_INVALID_INPUT',
      );
    }
    await w.axeda.staff.changePin(me, { currentPin: pin, newPin: '58203947' });
    await rejectsWith(w.signIn('mesero1', pin), 'AXEDA_STAFF_SIGN_IN_FAILED');
    expect(await w.signIn('mesero1', '58203947')).toEqual({ userId: member.userId });
    // Una cuenta completa no tiene PIN.
    await rejectsWith(
      w.axeda.staff.changePin(w.owner, { currentPin: pin, newPin: '58203947' }),
      'AXEDA_STAFF_NOT_FOUND',
    );
  });
});

describe('staff and the life of their place', () => {
  it('goes away with its company when it is purged, users included', async () => {
    const w = await world();
    const { member } = await w.hire(w.owner);
    const company = await w.persistence.companies.get('A');
    await w.axeda.companies.delete(w.admin, 'A', company?.version ?? 0);
    w.clock.current = new Date(w.clock.current.getTime() + 31 * DAY);
    await w.axeda.purgeDeleted();
    expect(await w.persistence.staff.get(member.userId)).toBeNull();
    expect(await w.users.get(member.userId)).toBeNull();
  });

  it('goes away right away when its site is deleted for good', async () => {
    const w = await world();
    const { member } = await w.hire(w.owner, { scope: { type: 'site', id: 'hq' } });
    const hq = await w.persistence.sites.get('hq');
    await w.axeda.sites.delete(w.admin, 'hq', hq?.version ?? 0, { immediate: true });
    expect(await w.persistence.staff.get(member.userId)).toBeNull();
    expect(await w.users.get(member.userId)).toBeNull();
  });

  it('is off without a PIN hasher', async () => {
    const f = await createFixture(undefined, { staff: false });
    await f.company('A');
    await rejectsWith(
      f.axeda.staff.create(f.admin, {
        scope: { type: 'company', id: 'A' },
        username: 'abc',
        name: 'A',
      }),
      'AXEDA_FEATURE_DISABLED',
    );
    await rejectsWith(
      f.axeda.staff.signIn({ company: 'a', username: 'abc', pin: '381946' }),
      'AXEDA_FEATURE_DISABLED',
    );
  });
});
