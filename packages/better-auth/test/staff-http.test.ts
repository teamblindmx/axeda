import { describe, expect, it } from 'vitest';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

interface Created {
  member: { userId: string; username: string };
  pin: string;
}

async function world(kind: (typeof databaseKinds)[number]) {
  const app = await createHttpApp({ kind });
  const owner = await app.signUp('owner');
  await app.plugin.instance().bootstrap({ userId: owner.id });
  const company = ok(
    await app.post('/axeda/company/create', { slug: 'acme', name: 'ACME' }, owner.cookie),
  ) as { id: string };
  const waiterRole = ok(
    await app.post(
      '/axeda/role/create',
      { key: 'waiter', name: 'Waiter', permissions: ['invoice:read', 'invoice:create'] },
      owner.cookie,
    ),
  ) as { id: string };
  const hire = async (username = 'mesero1') =>
    ok(
      await app.post(
        '/axeda/staff/create',
        {
          scope: { type: 'company', id: company.id },
          username,
          name: 'Mesero Uno',
          roleIds: [waiterRole.id],
        },
        owner.cookie,
      ),
    ) as Created;
  const signIn = (username: string, pin: string) =>
    app.post('/axeda/staff/sign-in', { company: 'acme', username, pin });
  return { app, owner, company, hire, signIn };
}

const otherPin = (pin: string) => (pin === '381946' ? '519372' : '381946');

describe.each(databaseKinds)('staff over HTTP (%s)', (kind) => {
  it('creates a staff account, shows the PIN once, and lets it sign in with a session', async () => {
    const { app, owner, hire, signIn } = await world(kind);
    const created = await hire();
    expect(created.pin).toMatch(/^\d{6}$/);
    expect(Object.keys(created.member).sort()).toEqual([
      'banned',
      'businessId',
      'companyId',
      'createdAt',
      'createdBy',
      'failedAttempts',
      'lockedUntil',
      'name',
      'pinChangedAt',
      'siteId',
      'userId',
      'username',
    ]);
    // Leerlo otra vez no da el PIN.
    const got = ok(
      await app.get('/axeda/staff/get', owner.cookie, { userId: created.member.userId }),
    );
    expect(JSON.stringify(got)).not.toContain(created.pin);

    const entered = await signIn('Mesero1', created.pin);
    expect(entered.status).toBe(200);
    expect(entered.json).toEqual({ userId: created.member.userId, name: 'Mesero Uno' });
    const me = ok(
      await app.get('/axeda/me', entered.cookies, {
        scopeType: 'company',
        scopeId: (await app.plugin.persistence().companies.getBySlug('acme'))?.id ?? '',
      }),
    ) as {
      userId: string;
      permissions: string[];
    };
    expect(me.userId).toBe(created.member.userId);
    expect(me.permissions).toEqual(['invoice:create', 'invoice:read']);
    const session = ok(await app.get('/get-session', entered.cookies)) as { user: { id: string } };
    expect(session.user.id).toBe(created.member.userId);
  });

  it('answers 401 with one code for every failure, and locks after five wrong PINs', async () => {
    const { hire, signIn } = await world(kind);
    const { pin } = await hire();
    for (const [username, attempt] of [
      ['nobody', pin],
      ['mesero1', 'abc'],
    ] as const) {
      const response = await signIn(username, attempt);
      expect([response.status, response.json.code]).toEqual([401, 'AXEDA_STAFF_SIGN_IN_FAILED']);
    }
    for (let i = 0; i < 5; i++) expect((await signIn('mesero1', otherPin(pin))).status).toBe(401);
    const locked = await signIn('mesero1', pin);
    expect([locked.status, locked.cookies]).toEqual([401, '']);
  });

  it('never accepts the PIN on the email sign-in of Better Auth', async () => {
    const { app, hire } = await world(kind);
    const { member, pin } = await hire();
    const context = await app.auth.$context;
    const user = (await context.internalAdapter.findUserById(member.userId)) as { email: string };
    const response = await app.post('/sign-in/email', { email: user.email, password: pin });
    expect(response.status).not.toBe(200);
    expect(response.cookies).toBe('');
  });

  it('resets the PIN (closing the open session) and lets staff change their own', async () => {
    const { app, owner, hire, signIn } = await world(kind);
    const { member, pin } = await hire();
    const entered = await signIn('mesero1', pin);
    const reset = ok(
      await app.post('/axeda/staff/reset-pin', { userId: member.userId }, owner.cookie),
    ) as { pin: string };
    expect((await app.get('/axeda/me', entered.cookies)).status).toBe(401);
    expect((await signIn('mesero1', pin)).status).toBe(401);

    const again = await signIn('mesero1', reset.pin);
    expect(again.status).toBe(200);
    const changed = await app.post(
      '/axeda/staff/change-pin',
      { currentPin: reset.pin, newPin: '58203947' },
      again.cookies,
    );
    expect(changed.json).toEqual({ changed: true });
    expect((await signIn('mesero1', '58203947')).status).toBe(200);
  });

  it('gives a staff session no way to administer, not even other staff', async () => {
    const { app, company, hire, signIn } = await world(kind);
    const { pin } = await hire();
    const entered = await signIn('mesero1', pin);
    const response = await app.post(
      '/axeda/staff/create',
      { scope: { type: 'company', id: company.id }, username: 'otro1', name: 'Otro' },
      entered.cookies,
    );
    expect([response.status, response.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
    expect((await app.get('/axeda/role/list', entered.cookies)).status).toBe(403);
  });

  it('suspends, reactivates and removes a staff member', async () => {
    const { app, owner, hire, signIn } = await world(kind);
    const { member, pin } = await hire();
    const userId = member.userId;
    expect(ok(await app.post('/axeda/staff/suspend', { userId }, owner.cookie))).toMatchObject({
      banned: true,
    });
    expect((await signIn('mesero1', pin)).status).toBe(401);
    ok(await app.post('/axeda/staff/reactivate', { userId }, owner.cookie));
    expect((await signIn('mesero1', pin)).status).toBe(200);
    expect(ok(await app.post('/axeda/staff/remove', { userId }, owner.cookie))).toEqual({
      removed: true,
    });
    expect((await signIn('mesero1', pin)).status).toBe(401);
    const list = ok(
      await app.get('/axeda/staff/list', owner.cookie, {
        scopeType: 'company',
        scopeId: (await app.plugin.persistence().companies.getBySlug('acme'))?.id ?? '',
      }),
    ) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });
});
