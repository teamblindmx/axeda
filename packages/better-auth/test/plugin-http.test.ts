import { describe, expect, it } from 'vitest';
import { toApiError } from '../src/http-errors.js';
import { AxedaError } from '@axeda/core';
import { createHttpApp, type HttpApp } from './support/http.js';

/** Un entorno con un administrador global, un usuario sin permisos y uno de otra compañía. */
async function world(options: Parameters<typeof createHttpApp>[0] = {}) {
  const app = await createHttpApp(options);
  const admin = await app.signUp('admin');
  const alice = await app.signUp('alice');
  const bob = await app.signUp('bob');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  return { app, admin, alice, bob };
}

const createCompany = async (app: HttpApp, cookie: string, slug: string) => {
  const response = await app.post(
    '/axeda/company/create',
    { slug, name: slug.toUpperCase() },
    cookie,
  );
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json as { id: string; version: number; slug: string };
};

const createRole = async (
  app: HttpApp,
  cookie: string,
  key: string,
  permissions: string[],
  extra: Record<string, unknown> = {},
) => {
  const response = await app.post(
    '/axeda/role/create',
    { key, name: key, permissions, ...extra },
    cookie,
  );
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json as { id: string; version: number };
};

describe('startup', () => {
  it('refuses to run with session.cookieCache enabled', async () => {
    await expect(
      createHttpApp({ betterAuth: { session: { cookieCache: { enabled: true, maxAge: 300 } } } }),
    ).rejects.toMatchObject({ code: 'AXEDA_INVALID_CONFIG' });
  });

  it.each([
    ['advanced.disableCSRFCheck', { advanced: { disableCSRFCheck: true } }],
    ['advanced.disableOriginCheck', { advanced: { disableOriginCheck: true } }],
    [
      'advanced.ipAddress.disableIpTracking',
      { advanced: { ipAddress: { disableIpTracking: true } } },
    ],
  ])('refuses to run with %s', async (option, betterAuth) => {
    await expect(createHttpApp({ betterAuth })).rejects.toMatchObject({
      code: 'AXEDA_INVALID_CONFIG',
      message: expect.stringContaining(option),
    });
  });

  it('exposes the core only after Better Auth has been created', async () => {
    const { axeda } = await import('../src/index.js');
    const plugin = axeda({ permissions: [] });
    expect(() => plugin.instance()).toThrow(/not initialised/);
    expect(() => plugin.persistence()).toThrow();
  });

  it('declares a rate limit for its endpoints', async () => {
    const { plugin } = await createHttpApp();
    expect(plugin.rateLimit.some((rule) => rule.pathMatcher('/axeda/role/create'))).toBe(true);
    expect(plugin.rateLimit.some((rule) => rule.pathMatcher('/sign-in/email'))).toBe(false);
  });
});

/**
 * La prueba de todos los endpoints (T3): cada endpoint del plugin debe exigir sesión y permiso.
 * Si alguien añade un endpoint y olvida protegerlo, o no lo registra aquí, esta prueba falla.
 */
describe('every endpoint requires a session and a permission', () => {
  interface Sample {
    method: 'GET' | 'POST';
    query?: Record<string, string>;
    body?: unknown;
    /** Estados válidos para alguien con sesión pero sin ningún permiso. */
    unprivileged?: number[];
    /** No exige sesión. */
    public?: true;
  }
  const NOPE = { id: 'x', version: 1 };
  const SAMPLES: Record<string, Sample> = {
    '/axeda/me': { method: 'GET', unprivileged: [200] },
    '/axeda/permission/list': { method: 'GET' },
    '/axeda/role/list': { method: 'GET' },
    '/axeda/role/get': { method: 'GET', query: { id: 'x' } },
    '/axeda/role/create': {
      method: 'POST',
      body: { key: 'walker', name: 'W', permissions: ['invoice:read'] },
    },
    '/axeda/role/update': { method: 'POST', body: { ...NOPE, name: 'n' } },
    '/axeda/role/set-status': { method: 'POST', body: { ...NOPE, status: 'inactive' } },
    '/axeda/role/delete': { method: 'POST', body: { id: 'x' } },
    '/axeda/assignment/list': { method: 'GET', query: { scopeType: 'global' } },
    '/axeda/assignment/create': {
      method: 'POST',
      body: { userId: 'x', roleId: 'x', scope: { type: 'global' } },
    },
    '/axeda/assignment/revoke': { method: 'POST', body: { id: 'x' } },
    '/axeda/audit/list': { method: 'GET' },
    // Compañías y negocios: listar da una lista vacía a quien no pertenece a ninguna.
    '/axeda/company/list': { method: 'GET', unprivileged: [200] },
    '/axeda/company/get': { method: 'GET', query: { id: 'x' } },
    '/axeda/company/create': { method: 'POST', body: { slug: 'walker', name: 'W' } },
    '/axeda/company/update': { method: 'POST', body: { ...NOPE, name: 'n' } },
    '/axeda/company/set-status': { method: 'POST', body: { ...NOPE, status: 'inactive' } },
    '/axeda/company/delete': { method: 'POST', body: NOPE },
    '/axeda/company/restore': { method: 'POST', body: NOPE },
    '/axeda/business/list': { method: 'GET', query: { companyId: 'x' } },
    '/axeda/business/get': { method: 'GET', query: { id: 'x' } },
    '/axeda/business/create': {
      method: 'POST',
      body: { companyId: 'x', slug: 'walker', name: 'W' },
    },
    '/axeda/business/update': { method: 'POST', body: { ...NOPE, name: 'n' } },
    '/axeda/business/set-status': { method: 'POST', body: { ...NOPE, status: 'inactive' } },
    '/axeda/business/delete': { method: 'POST', body: NOPE },
    '/axeda/business/restore': { method: 'POST', body: NOPE },
    '/axeda/invitation/list': { method: 'GET', query: { scopeType: 'global' } },
    '/axeda/invitation/create': {
      method: 'POST',
      body: { email: 'a@test.dev', scope: { type: 'global' }, roleIds: ['x'] },
    },
    // Aceptar solo pide sesión: lo autoriza el secreto, y uno inventado no sirve.
    '/axeda/invitation/accept': { method: 'POST', body: { token: 'x.y' }, unprivileged: [400] },
    '/axeda/invitation/revoke': { method: 'POST', body: { id: 'x' }, unprivileged: [400] },
    // Usuarios (solo global) y menú (cada persona ve el suyo).
    '/axeda/user/list': { method: 'GET' },
    '/axeda/user/create': { method: 'POST', body: { email: 'walker@test.dev', name: 'W' } },
    '/axeda/user/ban': { method: 'POST', body: { id: 'x' } },
    '/axeda/user/unban': { method: 'POST', body: { id: 'x' } },
    '/axeda/user/revoke-sessions': { method: 'POST', body: { id: 'x' } },
    '/axeda/menu': { method: 'GET', unprivileged: [200] },
    '/axeda/public/identity': {
      method: 'GET',
      query: { company: 'x' },
      unprivileged: [404],
      public: true,
    },
  };

  const send = (app: HttpApp, path: string, cookie?: string) => {
    const sample = SAMPLES[path] as Sample;
    return sample.method === 'GET'
      ? app.get(path, cookie, sample.query)
      : app.post(path, sample.body, cookie);
  };
  const protectedPaths = Object.keys(SAMPLES).filter((path) => SAMPLES[path]?.public !== true);

  it('covers exactly the endpoints the plugin exposes', async () => {
    const { plugin } = await createHttpApp();
    const paths = Object.values(plugin.endpoints).map((endpoint) => endpoint.path);
    expect(paths.sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it('declares what each one requires, and only the public identity skips the session', async () => {
    const { plugin } = await createHttpApp();
    for (const endpoint of Object.values(plugin.endpoints)) {
      const metadata = endpoint.options.metadata as
        { axeda?: { requires?: string; public?: boolean } } | undefined;
      expect(metadata?.axeda?.requires, endpoint.path).toEqual(expect.any(String));
      expect(['GET', 'POST'], endpoint.path).toContain(endpoint.options.method);
      expect(metadata?.axeda?.public === true, endpoint.path).toBe(
        SAMPLES[endpoint.path]?.public === true,
      );
    }
  });

  it('answers 401 to every protected endpoint without a session', async () => {
    const { app } = await world();
    for (const path of protectedPaths) {
      expect((await send(app, path)).status, path).toBe(401);
    }
  });

  it('answers 401 for a forged or garbage session cookie', async () => {
    const { app } = await world();
    for (const cookie of ['better-auth.session_token=garbage', 'better-auth.session_token=a.b']) {
      for (const path of protectedPaths) {
        expect((await send(app, path, cookie)).status, path).toBe(401);
      }
    }
  });

  it('gives a signed-in user with no permissions nothing but their own data', async () => {
    const { app, alice } = await world();
    for (const path of Object.keys(SAMPLES)) {
      const response = await send(app, path, alice.cookie);
      const allowed = SAMPLES[path]?.unprivileged ?? [403, 404];
      expect(allowed, `${path} → ${response.status} ${JSON.stringify(response.json)}`).toContain(
        response.status,
      );
      if (response.status >= 400)
        expect(response.json?.code, path).toEqual(expect.stringMatching(/^AXEDA_/));
    }
    // y lo que se ve con permiso 200 está vacío
    expect((await app.get('/axeda/company/list', alice.cookie)).json.items).toEqual([]);
  });

  it('lets the global administrator reach every endpoint', async () => {
    const { app, admin } = await world();
    for (const path of Object.keys(SAMPLES)) {
      const response = await send(app, path, admin.cookie);
      expect([401, 403, 500], `${path} → ${response.status}`).not.toContain(response.status);
    }
  });
});

describe('the administration flow over HTTP', () => {
  it('create role → assign → the user holds it → revoke → the user loses it', async () => {
    const { app, admin, alice } = await world();
    const role = await createRole(app, admin.cookie, 'cashier', ['invoice:read', 'invoice:create']);

    const before = await app.get('/axeda/me', alice.cookie);
    expect(before.json.globalPermissions).toEqual([]);

    const assigned = await app.post(
      '/axeda/assignment/create',
      { userId: alice.id, roleId: role.id, scope: { type: 'global' } },
      admin.cookie,
    );
    expect(assigned.status).toBe(200);
    expect(assigned.json).toMatchObject({
      userId: alice.id,
      grantedBy: admin.id,
      scope: { type: 'global' },
    });

    const after = await app.get('/axeda/me', alice.cookie);
    expect(after.json.globalPermissions).toEqual(['invoice:create', 'invoice:read']);
    expect(await app.plugin.instance().can({ userId: alice.id }, 'invoice:read')).toBe(true);

    const revoked = await app.post(
      '/axeda/assignment/revoke',
      { id: assigned.json.id },
      admin.cookie,
    );
    expect(revoked.json).toEqual({ revoked: true });
    const gone = await app.get('/axeda/me', alice.cookie);
    expect(gone.json.globalPermissions).toEqual([]);
    expect(gone.json.assignments).toEqual([]);
  });

  it('a company administrator manages only their own company, through the API', async () => {
    const { app, admin, alice, bob } = await world();
    const acme = await createCompany(app, admin.cookie, 'acme');
    const globex = await createCompany(app, admin.cookie, 'globex');
    const adminRole = await createRole(app, admin.cookie, 'company-admin', [
      'axeda:assignment:manage',
      'invoice:read',
    ]);
    const reader = await createRole(app, admin.cookie, 'reader', ['invoice:read']);
    const boss = await app.signUp('boss');
    await app.post(
      '/axeda/assignment/create',
      { userId: boss.id, roleId: adminRole.id, scope: { type: 'company', id: acme.id } },
      admin.cookie,
    );

    const ownCompany = await app.post(
      '/axeda/assignment/create',
      { userId: alice.id, roleId: reader.id, scope: { type: 'company', id: acme.id } },
      boss.cookie,
    );
    expect(ownCompany.status).toBe(200);

    for (const scope of [{ type: 'company', id: globex.id }, { type: 'global' }]) {
      const denied = await app.post(
        '/axeda/assignment/create',
        { userId: bob.id, roleId: reader.id, scope },
        boss.cookie,
      );
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('AXEDA_FORBIDDEN');
    }

    const team = await app.get('/axeda/assignment/list', boss.cookie, {
      scopeType: 'company',
      scopeId: acme.id,
    });
    expect(team.status).toBe(200);
    expect(team.json.items.map((item: { userId: string }) => item.userId).sort()).toEqual(
      [alice.id, boss.id].sort(),
    );
    const other = await app.get('/axeda/assignment/list', boss.cookie, {
      scopeType: 'company',
      scopeId: globex.id,
    });
    expect(other.status).toBe(403);
  });

  it('writes an audit trail readable only by someone with audit:read', async () => {
    const { app, admin, alice } = await world();
    await createRole(app, admin.cookie, 'cashier', ['invoice:read']);
    await app.post(
      '/axeda/role/create',
      { key: 'bad key', name: 'x', permissions: ['invoice:read'] },
      alice.cookie,
    );

    const log = await app.get('/axeda/audit/list', admin.cookie, { action: 'role.create' });
    expect(log.status).toBe(200);
    expect(log.json.items).toHaveLength(2);
    expect(log.json.items.map((item: { outcome: string }) => item.outcome).sort()).toEqual([
      'denied',
      'success',
    ]);

    expect((await app.get('/axeda/audit/list', alice.cookie)).status).toBe(403);
  });

  it('paginates with a cursor', async () => {
    const { app, admin } = await world();
    for (const key of ['a', 'b', 'c']) await createRole(app, admin.cookie, key, ['invoice:read']);
    const first = await app.get('/axeda/role/list', admin.cookie, { limit: '2' });
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await app.get('/axeda/role/list', admin.cookie, {
      limit: '2',
      cursor: first.json.nextCursor,
    });
    const keys = [...first.json.items, ...second.json.items].map(
      (role: { key: string }) => role.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['a', 'b', 'c', 'super-admin']));
    expect((await app.get('/axeda/role/list', admin.cookie, { limit: '1000' })).status).toBe(400);
  });
});

describe('errors and input validation', () => {
  it('rejects unknown fields and malformed bodies with 400, before touching anything', async () => {
    const { app, admin } = await world();
    const bad = [
      { key: 'ok', name: 'x', permissions: ['invoice:read'], managed: true },
      { key: 'ok', name: 'x' },
      { key: 'ok', name: 'x', permissions: 'invoice:read' },
      'not an object',
    ];
    for (const body of bad) {
      const response = await app.post('/axeda/role/create', body, admin.cookie);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await app.get('/axeda/role/list', admin.cookie, { surprise: '1' })).status).toBe(400);
  });

  it('maps core errors to stable codes and statuses', async () => {
    const { app, admin } = await world();
    const role = await createRole(app, admin.cookie, 'cashier', ['invoice:read']);

    const duplicate = await app.post(
      '/axeda/role/create',
      { key: 'cashier', name: 'x', permissions: ['invoice:read'] },
      admin.cookie,
    );
    expect([duplicate.status, duplicate.json.code]).toEqual([409, 'AXEDA_ROLE_KEY_TAKEN']);

    const typo = await app.post(
      '/axeda/role/create',
      { key: 'typo', name: 'x', permissions: ['invoice:raed'] },
      admin.cookie,
    );
    expect([typo.status, typo.json.code]).toEqual([400, 'AXEDA_INVALID_INPUT']);

    const stale = await app.post(
      '/axeda/role/update',
      { id: role.id, version: 9, name: 'n' },
      admin.cookie,
    );
    expect([stale.status, stale.json.code]).toEqual([409, 'AXEDA_VERSION_CONFLICT']);

    const missing = await app.get('/axeda/role/get', admin.cookie, { id: 'nope' });
    expect([missing.status, missing.json.code]).toEqual([404, 'AXEDA_ROLE_NOT_FOUND']);

    const managed = await app.get('/axeda/role/list', admin.cookie);
    const superAdmin = managed.json.items.find((item: { managed: boolean }) => item.managed);
    const protectedRole = await app.post('/axeda/role/delete', { id: superAdmin.id }, admin.cookie);
    expect([protectedRole.status, protectedRole.json.code]).toEqual([409, 'AXEDA_ROLE_MANAGED']);
  });

  it('rejects an invalid scope, and a business that does not exist', async () => {
    const { app, admin, alice } = await world();
    const role = await createRole(app, admin.cookie, 'cashier', ['invoice:read']);
    const send = (scope: unknown) =>
      app.post(
        '/axeda/assignment/create',
        { userId: alice.id, roleId: role.id, scope },
        admin.cookie,
      );
    expect((await send({ type: 'planet', id: 'x' })).status).toBe(400);
    expect((await send({ type: 'business', id: 'nope' })).status).toBe(400);
    expect((await send({ type: 'company', id: 'nope' })).status).toBe(400);
  });

  it('turns an unexpected failure into a generic 500 that leaks nothing', () => {
    const secret = new Error('connection to db.internal.example:5432 refused, password=hunter2');
    const api = toApiError(secret);
    expect(api.statusCode).toBe(500);
    expect(JSON.stringify(api.body)).not.toMatch(/hunter2|internal|5432/);
    expect(api.body).toMatchObject({ code: 'AXEDA_INTERNAL_ERROR' });
    expect(
      toApiError(new AxedaError('AXEDA_DATA_CORRUPT', 'row 17 of axedaRole is broken')).statusCode,
    ).toBe(500);
  });
});

describe('what responses contain', () => {
  it('returns only whitelisted fields', async () => {
    const { app, admin } = await world();
    const role = await createRole(app, admin.cookie, 'cashier', ['invoice:read']);
    const me = await app.get('/axeda/me', admin.cookie);
    expect(Object.keys(me.json).sort()).toEqual([
      'assignments',
      'globalPermissions',
      'twoFactorEnabled',
      'userId',
    ]);
    expect(Object.keys(role).length).toBeGreaterThan(0);

    const got = await app.get('/axeda/role/get', admin.cookie, { id: role.id });
    expect(Object.keys(got.json).sort()).toEqual([
      'createdAt',
      'description',
      'id',
      'key',
      'managed',
      'name',
      'permissions',
      'requireMfa',
      'status',
      'updatedAt',
      'version',
    ]);
    const assignments = me.json.assignments as Array<Record<string, unknown>>;
    expect(Object.keys(assignments[0] ?? {}).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'grantedBy',
      'id',
      'roleId',
      'scope',
      'userId',
    ]);
    const text = JSON.stringify([me.json, got.json]);
    expect(text).not.toMatch(/password|secret|token|hash/i);
  });

  it('does not accept the user-supplied actor, version or MFA state', async () => {
    const { app, alice } = await world();
    const response = await app.post(
      '/axeda/role/create',
      {
        key: 'x',
        name: 'x',
        permissions: ['invoice:read'],
        actor: 'admin',
        twoFactorEnabled: true,
      },
      alice.cookie,
    );
    expect(response.status).toBe(400);
    const header = await app.post(
      '/axeda/role/create',
      { key: 'x', name: 'x', permissions: ['invoice:read'] },
      alice.cookie,
    );
    expect(header.status).toBe(403);
  });
});

describe('user deletion', () => {
  it.each([true, false])(
    'removes the assignments and leaves an audit event (foreign keys: %s)',
    async (foreignKeys) => {
      const { app, admin, alice } = await world({ foreignKeys });
      const role = await createRole(app, admin.cookie, 'cashier', ['invoice:read']);
      await app.post(
        '/axeda/assignment/create',
        { userId: alice.id, roleId: role.id, scope: { type: 'global' } },
        admin.cookie,
      );
      const persistence = app.plugin.persistence();
      expect(await persistence.assignments.countForUser(alice.id)).toBe(1);

      await (await app.auth.$context).internalAdapter.deleteUser(alice.id);

      expect(await persistence.assignments.countForUser(alice.id)).toBe(0);
      const events = await persistence.audit.list({ action: 'user.delete' }, { limit: 5 });
      expect(events.items).toHaveLength(1);
      expect(events.items[0]).toMatchObject({ targetId: alice.id, actorId: null });
    },
  );
});

describe('on PostgreSQL', () => {
  it('runs the same flow', async () => {
    const { app, admin, alice } = await world({ kind: 'postgres' });
    const role = await createRole(app, admin.cookie, 'cashier', ['invoice:read']);
    await app.post(
      '/axeda/assignment/create',
      { userId: alice.id, roleId: role.id, scope: { type: 'global' } },
      admin.cookie,
    );
    expect((await app.get('/axeda/me', alice.cookie)).json.globalPermissions).toEqual([
      'invoice:read',
    ]);
    expect((await app.get('/axeda/audit/list', admin.cookie)).json.items.length).toBeGreaterThan(2);
  }, 60_000);
});
