import { describe, expect, it } from 'vitest';
import {
  administrativePower,
  authorizeUserAction,
  effectivePermissions,
  isAxedaError,
  isBanned,
  type AxedaErrorCode,
} from '../src/index.js';
import { k, keys, makeAssignment, makeRole, rolesById } from './helpers.js';
import { createFixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error & { details: Record<string, unknown> };
};

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('isBanned', () => {
  it('is calculated, never stored: an expiring ban stops applying by itself', () => {
    const until = new Date(NOW.getTime() + 1000);
    expect(isBanned({ banned: false, banExpires: null }, NOW)).toBe(false);
    expect(isBanned({ banned: true, banExpires: null }, NOW)).toBe(true);
    expect(isBanned({ banned: true, banExpires: until }, NOW)).toBe(true);
    expect(isBanned({ banned: true, banExpires: until }, until)).toBe(false);
    expect(isBanned({ banned: true, banExpires: until }, new Date(until.getTime() + 1))).toBe(
      false,
    );
    expect(isBanned({ banned: false, banExpires: until }, NOW)).toBe(false);
  });
});

describe('authorizeUserAction', () => {
  const held = (...raw: string[]) =>
    effectivePermissions({
      assignments: [makeAssignment({ roleId: 'r', scope: { type: 'global' } })],
      roles: rolesById(makeRole({ id: 'r', permissions: keys(...raw) })),
      target: { type: 'global' },
      now: NOW,
    });

  it('only counts administrative power: "*" and axeda permissions, not the app’s', () => {
    expect(
      administrativePower(held('invoice:read', 'axeda:role:manage', 'axeda:*')).sort(),
    ).toEqual(keys('axeda:*', 'axeda:role:manage'));
    expect(administrativePower(held('*'))).toEqual(keys('*'));
    expect(administrativePower(held('invoice:*', 'report:read'))).toEqual([]);
  });

  it('needs axeda:user:manage', () => {
    expect(
      authorizeUserAction({ actor: held('invoice:read'), target: held('invoice:read') }),
    ).toMatchObject({
      allowed: false,
      reason: 'missing_user_permission',
    });
  });

  it('lets a user manager act on people with only application permissions', () => {
    expect(
      authorizeUserAction({
        actor: held('axeda:user:manage'),
        target: held('invoice:*', 'report:read'),
      }),
    ).toEqual({ allowed: true });
  });

  it('refuses to act on someone with more administrative power', () => {
    const decision = authorizeUserAction({
      actor: held('axeda:user:manage'),
      target: held('axeda:role:manage', 'axeda:audit:read'),
    });
    expect(decision).toEqual({
      allowed: false,
      reason: 'target_has_more_power',
      permissions: keys('axeda:audit:read', 'axeda:role:manage'),
    });
    expect(
      authorizeUserAction({ actor: held('axeda:user:manage'), target: held('*') }),
    ).toMatchObject({
      allowed: false,
    });
  });

  it('lets someone with equal or greater power act', () => {
    expect(
      authorizeUserAction({
        actor: held('axeda:user:manage', 'axeda:role:manage'),
        target: held('axeda:role:manage'),
      }).allowed,
    ).toBe(true);
    expect(authorizeUserAction({ actor: held('*'), target: held('*') }).allowed).toBe(true);
  });

  it('knows nothing of a wildcard it only partly holds', () => {
    expect(
      authorizeUserAction({
        actor: held('axeda:user:manage', 'axeda:*'),
        target: held('axeda:role:manage'),
      }).allowed,
    ).toBe(true);
    expect(k('axeda:*')).toBeDefined();
  });
});

describe('a banned principal can do nothing', () => {
  it('denies every check, even though the assignments still exist (an API key reaches here without a session)', async () => {
    const f = await createFixture();
    await f.role('reader', ['invoice:read']);
    const alice = f.user('alice');
    await f.give('alice', 'reader');
    expect(await f.axeda.can(alice, 'invoice:read')).toBe(true);
    expect(await f.axeda.can({ ...alice, banned: true }, 'invoice:read')).toBe(false);
    expect(await f.axeda.scopesFor({ ...alice, banned: true }, 'invoice:read')).toEqual([]);
    expect(await f.axeda.canAnywhere({ ...alice, banned: true }, 'invoice:read')).toBe(false);
    expect((await f.axeda.effectivePermissions({ ...alice, banned: true })).keys).toEqual([]);
    // un administrador bloqueado tampoco administra
    await rejectsWith(
      f.axeda.roles.create(
        { ...f.admin, banned: true },
        { key: 'x', name: 'x', permissions: ['invoice:read'] },
      ),
      'AXEDA_FORBIDDEN',
    );
  });
});

describe('user administration', () => {
  async function world() {
    const f = await createFixture();
    await f.role('user-admin', ['axeda:user:manage']);
    await f.role('role-admin', ['axeda:role:manage']);
    await f.role('reader', ['invoice:read']);
    const support = f.user('support');
    await f.give('support', 'user-admin');
    const victim = f.user('victim');
    await f.give('victim', 'reader');
    return { ...f, support, victim };
  }

  it('creates an account without any credential, normalizing the email, and audits it', async () => {
    const w = await world();
    const created = await w.axeda.users.create(w.support, {
      email: '  New.Person@Test.DEV ',
      name: ' New Person ',
    });
    expect(created).toMatchObject({
      email: 'new.person@test.dev',
      name: 'New Person',
      emailVerified: false,
      banned: false,
    });
    expect(Object.keys(created).sort()).toEqual([
      'banExpires',
      'banReason',
      'banned',
      'createdAt',
      'email',
      'emailVerified',
      'id',
      'name',
      'twoFactorEnabled',
    ]);
    const [event] = (await w.axeda.listAudit(w.admin, { action: 'user.create' }, { limit: 1 }))
      .items;
    expect(event).toMatchObject({
      actorId: 'support',
      targetId: created.id,
      metadata: { email: 'new.person@test.dev' },
    });
  });

  it('rejects a duplicate email, invalid input and unknown fields', async () => {
    const w = await world();
    await w.axeda.users.create(w.support, { email: 'a@test.dev', name: 'A' });
    await rejectsWith(
      w.axeda.users.create(w.support, { email: 'A@test.dev', name: 'again' }),
      'AXEDA_EMAIL_TAKEN',
    );
    const bad = (input: unknown) => w.axeda.users.create(w.support, input as never);
    await rejectsWith(bad({ email: 'nope', name: 'x' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad({ email: 'b@test.dev', name: '' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      bad({ email: 'b@test.dev', name: 'x', password: 'secret123' }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ email: 'b@test.dev', name: 'x', emailVerified: true }),
      'AXEDA_INVALID_INPUT',
    );
  });

  it('authorizes before validating, so a stranger learns which emails exist', async () => {
    const w = await world();
    await w.axeda.users.create(w.support, { email: 'taken@test.dev', name: 'T' });
    const stranger = w.user('stranger');
    for (const input of [
      { email: 'taken@test.dev', name: 'x' },
      { email: 'nope', name: 'x' },
    ]) {
      await rejectsWith(w.axeda.users.create(stranger, input as never), 'AXEDA_FORBIDDEN');
    }
  });

  it('lists users with a filter and pagination, only for a user manager', async () => {
    const w = await world();
    const page = await w.axeda.users.list(w.support, { emailPrefix: 'vic' }, { limit: 10 });
    expect(page.items.map((u) => u.id)).toEqual(['victim']);
    const all = await w.axeda.users.list(w.support, {}, { limit: 2 });
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).not.toBeNull();
    await rejectsWith(w.axeda.users.list(w.victim, {}, { limit: 10 }), 'AXEDA_FORBIDDEN');
  });

  it('bans a user: their power disappears, their sessions close, and it is audited', async () => {
    const w = await world();
    w.users.addSessions('victim', 3);
    expect(await w.axeda.can(w.victim, 'invoice:read')).toBe(true);

    const banned = await w.axeda.users.ban(w.support, 'victim', { reason: 'abuse' });
    expect(banned).toMatchObject({ banned: true, banReason: 'abuse', banExpires: null });
    expect(w.users.sessionsOf('victim')).toBe(0);
    expect((await w.users.find('victim'))?.banned).toBe(true);

    const [event] = (await w.axeda.listAudit(w.admin, { action: 'user.ban' }, { limit: 1 })).items;
    expect(event).toMatchObject({
      actorId: 'support',
      targetId: 'victim',
      outcome: 'success',
      metadata: { reason: 'abuse', sessionsClosed: 3 },
    });
  });

  it('a timed ban lifts itself, and an unban lifts it at once', async () => {
    const w = await world();
    const until = new Date(w.clock.current.getTime() + 3_600_000);
    await w.axeda.users.ban(w.support, 'victim', { expiresAt: until });
    expect((await w.users.find('victim'))?.banned).toBe(true);
    w.clock.current = until;
    expect((await w.users.find('victim'))?.banned).toBe(false);

    await w.axeda.users.ban(w.support, 'victim');
    const lifted = await w.axeda.users.unban(w.support, 'victim');
    expect(lifted).toMatchObject({ banned: false, banReason: null, banExpires: null });
  });

  it('rejects a ban that ends in the past, and a reason that is too long', async () => {
    const w = await world();
    await rejectsWith(
      w.axeda.users.ban(w.support, 'victim', {
        expiresAt: new Date(w.clock.current.getTime() - 1),
      }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      w.axeda.users.ban(w.support, 'victim', { reason: 'x'.repeat(501) }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      w.axeda.users.ban(w.support, 'victim', { surprise: 1 } as never),
      'AXEDA_INVALID_INPUT',
    );
  });

  it('refuses to let someone ban themselves', async () => {
    const w = await world();
    await rejectsWith(w.axeda.users.ban(w.support, 'support'), 'AXEDA_INVALID_INPUT');
    expect((await w.users.find('support'))?.banned).toBe(false);
  });

  it('protects people with more administrative power: they cannot be banned, unbanned or signed out', async () => {
    const w = await world();
    const boss = w.user('boss');
    await w.give('boss', 'role-admin');
    w.users.addSessions('boss', 2);
    for (const attempt of [
      () => w.axeda.users.ban(w.support, 'boss'),
      () => w.axeda.users.unban(w.support, 'boss'),
      () => w.axeda.users.revokeSessions(w.support, 'boss'),
      () => w.axeda.users.ban(w.support, 'admin'),
    ]) {
      const error = await rejectsWith(attempt(), 'AXEDA_FORBIDDEN');
      expect(error.details['reason']).toBe('target_has_more_power');
    }
    expect(w.users.sessionsOf('boss')).toBe(2);
    expect((await w.users.find('boss'))?.banned).toBe(false);
    // y el global sí puede
    await w.axeda.users.ban(w.admin, 'boss');
    void boss;
  });

  it('hides whether a user exists from someone who cannot manage users', async () => {
    const w = await world();
    const stranger = w.user('stranger');
    for (const id of ['victim', 'ghost']) {
      await rejectsWith(w.axeda.users.ban(stranger, id), 'AXEDA_FORBIDDEN');
      await rejectsWith(w.axeda.users.revokeSessions(stranger, id), 'AXEDA_FORBIDDEN');
    }
    await rejectsWith(w.axeda.users.ban(w.support, 'ghost'), 'AXEDA_USER_NOT_FOUND');
    const denied = await w.axeda.listAudit(w.admin, { actorId: 'stranger' }, { limit: 10 });
    expect(denied.items.every((e) => e.outcome === 'denied')).toBe(true);
    expect(denied.items).toHaveLength(4);
  });

  it('revokes sessions and reports how many were closed', async () => {
    const w = await world();
    w.users.addSessions('victim', 4);
    expect(await w.axeda.users.revokeSessions(w.support, 'victim')).toBe(4);
    expect(await w.axeda.users.revokeSessions(w.support, 'victim')).toBe(0);
    expect((await w.users.find('victim'))?.banned).toBe(false);
  });

  it('bumps the user version so their cached permissions are never reused', async () => {
    const w = await world();
    const before = await w.persistence.authz.getUserVersion('victim');
    await w.axeda.users.ban(w.support, 'victim');
    expect(await w.persistence.authz.getUserVersion('victim')).toBeGreaterThan(before);
  });

  it('is disabled when no user administration is configured', async () => {
    const { createAxeda } = await import('../src/index.js');
    const { createMemoryPersistence, createMemoryUserDirectory } = await import('@axeda/testing');
    const axeda = createAxeda(
      { permissions: ['a:b'] },
      { persistence: createMemoryPersistence(), users: createMemoryUserDirectory() },
    );
    await rejectsWith(
      axeda.users.list({ userId: 'x' }, {}, { limit: 1 }),
      'AXEDA_FEATURE_DISABLED',
    );
  });
});
