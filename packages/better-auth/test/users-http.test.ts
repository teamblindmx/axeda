import { describe, expect, it } from 'vitest';
import { principalFromSession } from '../src/index.js';
import { localeFromHeader } from '../src/endpoints-users.js';
import { createHttpApp, PASSWORD, type HttpApp } from './support/http.js';

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

async function world() {
  const app = await createHttpApp();
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  const role = (key: string, permissions: string[]) =>
    app
      .post('/axeda/role/create', { key, name: key, permissions }, admin.cookie)
      .then((r) => ok(r) as { id: string });
  const give = async (userId: string, roleId: string, scope: unknown = { type: 'global' }) =>
    ok(await app.post('/axeda/assignment/create', { userId, roleId, scope }, admin.cookie));
  return { app, admin, role, give };
}

const signIn = (app: HttpApp, name: string) =>
  app.auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email: `${name}@test.dev`, password: PASSWORD }),
    }),
  );

describe('user administration over HTTP', () => {
  it('creates an account with no credential: the person cannot sign in until they set one', async () => {
    const { app, admin, role, give } = await world();
    const support = await app.signUp('support');
    await give(support.id, (await role('user-admin', ['axeda:user:manage'])).id);

    const created = ok(
      await app.post('/axeda/user/create', { email: 'New@Test.dev', name: 'New' }, support.cookie),
    ) as {
      id: string;
      email: string;
      emailVerified: boolean;
    };
    expect(created).toMatchObject({ email: 'new@test.dev', emailVerified: false });
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
    // sin contraseña ni cuenta de credenciales: no puede iniciar sesión
    const attempt = await app.auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'new@test.dev', password: PASSWORD }),
      }),
    );
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    const context = await app.auth.$context;
    expect(
      await context.adapter.count({
        model: 'account',
        where: [{ field: 'userId', value: created.id }],
      }),
    ).toBe(0);

    const dup = await app.post(
      '/axeda/user/create',
      { email: 'new@test.dev', name: 'again' },
      support.cookie,
    );
    expect([dup.status, dup.json.code]).toEqual([409, 'AXEDA_EMAIL_TAKEN']);
    const withPassword = await app.post(
      '/axeda/user/create',
      { email: 'x@test.dev', name: 'x', password: 'secret123' },
      support.cookie,
    );
    expect(withPassword.status).toBe(400);
    void admin;
  });

  it('lists users with a filter and never exposes credentials or tokens', async () => {
    const { app, admin } = await world();
    await app.signUp('alice');
    await app.signUp('albert');
    const list = ok(await app.get('/axeda/user/list', admin.cookie, { emailPrefix: 'al' })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items.map((u) => u['email']).sort()).toEqual(['albert@test.dev', 'alice@test.dev']);
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/password|token|hash|secret/i);
    const everyone = ok(await app.get('/axeda/user/list', admin.cookie, { limit: '2' })) as {
      nextCursor: string | null;
    };
    expect(everyone.nextCursor).toEqual(expect.any(String));
  });

  it('a ban closes the open sessions at once and stops new ones, then an unban allows them again', async () => {
    const { app, admin } = await world();
    const alice = await app.signUp('alice');
    expect((await app.get('/axeda/me', alice.cookie)).status).toBe(200);

    const banned = ok(
      await app.post('/axeda/user/ban', { id: alice.id, reason: 'abuse' }, admin.cookie),
    ) as { banned: boolean; banReason: string };
    expect(banned).toMatchObject({ banned: true, banReason: 'abuse' });

    expect((await app.get('/axeda/me', alice.cookie)).status).toBe(401);
    const login = await signIn(app, 'alice');
    expect(login.status).toBe(403);
    expect(JSON.stringify(await login.json())).toContain('AXEDA_USER_BANNED');

    ok(await app.post('/axeda/user/unban', { id: alice.id }, admin.cookie));
    expect((await signIn(app, 'alice')).status).toBe(200);
  });

  it('a timed ban lifts itself', async () => {
    const { app, admin } = await world();
    const alice = await app.signUp('alice');
    const soon = new Date(Date.now() + 1500).toISOString();
    ok(await app.post('/axeda/user/ban', { id: alice.id, expiresAt: soon }, admin.cookie));
    expect((await signIn(app, 'alice')).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect((await signIn(app, 'alice')).status).toBe(200);
    // y el usuario figura como no bloqueado, sin que nadie lo desbloquee
    const list = ok(await app.get('/axeda/user/list', admin.cookie, { emailPrefix: 'alice' })) as {
      items: Array<{ banned: boolean }>;
    };
    expect(list.items[0]?.banned).toBe(false);
  });

  it('a banned person has no authority even if they get in without a session (an API key)', async () => {
    const { app, admin, role, give } = await world();
    const alice = await app.signUp('alice');
    await give(alice.id, (await role('reader', ['invoice:read'])).id);
    const core = app.plugin.instance();
    expect(await core.can({ userId: alice.id }, 'invoice:read')).toBe(true);

    ok(await app.post('/axeda/user/ban', { id: alice.id }, admin.cookie));
    const session = await app.auth.api.getSession({
      headers: new Headers({ cookie: alice.cookie }),
    });
    expect(session).toBeNull();
    // Quien llega por una vía sin sesión usa `principalFromSession` con la fila del usuario:
    const context = await app.auth.$context;
    const row = await context.adapter.findOne<{
      id: string;
      banned: boolean;
      banExpires: Date | null;
    }>({
      model: 'user',
      where: [{ field: 'id', value: alice.id }],
    });
    const principal = principalFromSession({
      context: { session: { user: { ...row, id: alice.id } } },
    });
    expect(principal.banned).toBe(true);
    expect(await core.can(principal, 'invoice:read')).toBe(false);
    expect(await core.can({ userId: alice.id, banned: false }, 'invoice:read')).toBe(true);
  });

  it('protects more powerful people, and does not let anyone ban themselves', async () => {
    const { app, admin, role, give } = await world();
    const support = await app.signUp('support');
    await give(support.id, (await role('user-admin', ['axeda:user:manage'])).id);
    const forbidden = await app.post('/axeda/user/ban', { id: admin.id }, support.cookie);
    expect([forbidden.status, forbidden.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
    const self = await app.post('/axeda/user/ban', { id: support.id }, support.cookie);
    expect(self.status).toBe(400);
    expect((await app.get('/axeda/me', admin.cookie)).status).toBe(200);
  });

  it('revokes every session of a user and reports how many', async () => {
    const { app, admin } = await world();
    const alice = await app.signUp('alice');
    const second = await signIn(app, 'alice');
    expect(second.status).toBe(200);
    const closed = ok(
      await app.post('/axeda/user/revoke-sessions', { id: alice.id }, admin.cookie),
    ) as { revoked: number };
    expect(closed.revoked).toBe(2);
    expect((await app.get('/axeda/me', alice.cookie)).status).toBe(401);
  });

  it('keeps users out of reach of anyone without the permission, answering alike for real and unknown ids', async () => {
    const { app } = await world();
    const alice = await app.signUp('alice');
    const bob = await app.signUp('bob');
    for (const id of [bob.id, 'ghost']) {
      const response = await app.post('/axeda/user/ban', { id }, alice.cookie);
      expect([response.status, response.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
    }
    expect((await app.get('/axeda/user/list', alice.cookie)).status).toBe(403);
  });
});

describe('menu over HTTP', () => {
  it('shows each person only what they can use, in their language', async () => {
    const { app, role, give } = await world();
    const alice = await app.signUp('alice');
    const nobody = await app.signUp('nobody');
    await give(alice.id, (await role('biller', ['invoice:read', 'invoice:create'])).id);

    expect((await app.get('/axeda/menu', nobody.cookie)).json).toEqual({ items: [] });

    const en = (await app.get('/axeda/menu', alice.cookie)).json;
    expect(en.items).toHaveLength(1);
    expect(en.items[0]).toMatchObject({ key: 'billing', label: 'Billing', icon: 'receipt' });
    expect(en.items[0].children[0]).toMatchObject({
      key: 'invoices',
      label: 'Invoices',
      path: '/facturas',
      can: { 'invoice:create': true, 'invoice:delete': false },
    });
    const es = (await app.get('/axeda/menu', alice.cookie, { locale: 'es' })).json;
    expect(es.items[0].label).toBe('Facturación');
    expect(es.items[0].children[0].label).toBe('Facturas');
  });

  it('uses Accept-Language when no locale is given, and rejects a malformed one', async () => {
    const { app, admin } = await world();
    const response = await app.auth.handler(
      new Request('http://localhost:3000/api/auth/axeda/menu', {
        headers: { cookie: admin.cookie, 'accept-language': 'es-MX,es;q=0.9,en;q=0.8' },
      }),
    );
    const body = (await response.json()) as { items: Array<{ label: string }> };
    expect(body.items[0]?.label).toBe('Facturación');
    expect((await app.get('/axeda/menu', admin.cookie, { locale: '<script>' })).status).toBe(400);
    expect(localeFromHeader('es-MX,es;q=0.9')).toBe('es-MX');
    expect(localeFromHeader('*')).toBeUndefined();
    expect(localeFromHeader('')).toBeUndefined();
    expect(localeFromHeader(null)).toBeUndefined();
  });

  it('is evaluated in the requested scope and is empty for scopes that do not exist', async () => {
    const { app, admin, role, give } = await world();
    const company = ok(
      await app.post('/axeda/company/create', { slug: 'acme', name: 'ACME' }, admin.cookie),
    ) as { id: string };
    const alice = await app.signUp('alice');
    await give(alice.id, (await role('reader', ['invoice:read'])).id, {
      type: 'company',
      id: company.id,
    });

    expect((await app.get('/axeda/menu', alice.cookie)).json.items).toEqual([]);
    const inCompany = await app.get('/axeda/menu', alice.cookie, {
      scopeType: 'company',
      scopeId: company.id,
    });
    expect(inCompany.json.items).toHaveLength(1);
    expect(
      (await app.get('/axeda/menu', alice.cookie, { scopeType: 'company', scopeId: 'ghost' })).json
        .items,
    ).toEqual([]);
    expect(
      (await app.get('/axeda/menu', admin.cookie, { scopeType: 'business', scopeId: 'ghost' })).json
        .items,
    ).toEqual([]);
  });
});
