import { describe, expect, it } from 'vitest';
import { createHttpApp, BASE_URL, type HttpApp } from './support/http.js';

async function world() {
  const app = await createHttpApp();
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  return { app, admin };
}

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

const company = async (app: HttpApp, cookie: string, slug: string) =>
  ok(await app.post('/axeda/company/create', { slug, name: slug.toUpperCase() }, cookie)) as {
    id: string;
    version: number;
    slug: string;
  };

const role = async (app: HttpApp, cookie: string, key: string, permissions: string[]) =>
  ok(await app.post('/axeda/role/create', { key, name: key, permissions }, cookie)) as {
    id: string;
  };

/** Simula el enlace de verificación de correo de Better Auth. */
async function verifyEmail(app: HttpApp, userId: string): Promise<void> {
  const context = await app.auth.$context;
  await context.adapter.update({
    model: 'user',
    where: [{ field: 'id', value: userId }],
    update: { emailVerified: true },
  });
}

describe('companies over HTTP', () => {
  it('create, read, edit, deactivate, delete and restore', async () => {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');

    const got = await app.get('/axeda/company/get', admin.cookie, { id: acme.id });
    expect(Object.keys(got.json).sort()).toEqual([
      'createdAt',
      'deletedAt',
      'faviconUrl',
      'id',
      'legalName',
      'logoUrl',
      'metadata',
      'name',
      'slug',
      'status',
      'updatedAt',
      'version',
    ]);

    const edited = ok(
      await app.post(
        '/axeda/company/update',
        { id: acme.id, version: 1, name: 'ACME Inc', legalName: 'ACME S.A.' },
        admin.cookie,
      ),
    ) as { version: number; name: string };
    expect(edited).toMatchObject({ name: 'ACME Inc', version: 2 });

    const stale = await app.post(
      '/axeda/company/update',
      { id: acme.id, version: 1, name: 'x' },
      admin.cookie,
    );
    expect([stale.status, stale.json.code]).toEqual([409, 'AXEDA_VERSION_CONFLICT']);
    const again = await app.post(
      '/axeda/company/create',
      { slug: 'acme', name: 'dup' },
      admin.cookie,
    );
    expect([again.status, again.json.code]).toEqual([409, 'AXEDA_SLUG_TAKEN']);
    const badSlug = await app.post(
      '/axeda/company/create',
      { slug: 'Bad Slug', name: 'x' },
      admin.cookie,
    );
    expect(badSlug.status).toBe(400);
    const unsafe = await app.post(
      '/axeda/company/create',
      { slug: 'unsafe', name: 'x', logoUrl: 'javascript:alert(1)' },
      admin.cookie,
    );
    expect([unsafe.status, unsafe.json.code]).toEqual([400, 'AXEDA_INVALID_INPUT']);

    const off = ok(
      await app.post(
        '/axeda/company/set-status',
        { id: acme.id, version: 2, status: 'inactive' },
        admin.cookie,
      ),
    ) as { version: number; status: string };
    expect(off.status).toBe('inactive');
    ok(
      await app.post(
        '/axeda/company/set-status',
        { id: acme.id, version: off.version, status: 'active' },
        admin.cookie,
      ),
    );

    ok(await app.post('/axeda/company/delete', { id: acme.id, version: 4 }, admin.cookie));
    expect((await app.get('/axeda/company/list', admin.cookie)).json.items).toEqual([]);
    const deleted = (await app.get('/axeda/company/list', admin.cookie, { deleted: 'only' })).json
      .items;
    expect(deleted).toHaveLength(1);
    const restored = ok(
      await app.post(
        '/axeda/company/restore',
        { id: acme.id, version: deleted[0].version },
        admin.cookie,
      ),
    ) as { deletedAt: unknown };
    expect(restored.deletedAt).toBeNull();
  });

  it('shows each person only their own companies, and never leaks the others', async () => {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');
    const globex = await company(app, admin.cookie, 'globex');
    const adminRole = await role(app, admin.cookie, 'company-admin', [
      'axeda:company:manage',
      'axeda:business:manage',
      'invoice:read',
    ]);
    const boss = await app.signUp('boss');
    ok(
      await app.post(
        '/axeda/assignment/create',
        { userId: boss.id, roleId: adminRole.id, scope: { type: 'company', id: acme.id } },
        admin.cookie,
      ),
    );

    const mine = await app.get('/axeda/company/list', boss.cookie);
    expect(mine.json.items.map((item: { slug: string }) => item.slug)).toEqual(['acme']);
    expect((await app.get('/axeda/company/get', boss.cookie, { id: globex.id })).status).toBe(404);
    expect(
      (
        await app.post(
          '/axeda/company/update',
          { id: globex.id, version: 1, name: 'hack' },
          boss.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.post(
          '/axeda/company/update',
          { id: acme.id, version: 1, name: 'mine' },
          boss.cookie,
        )
      ).status,
    ).toBe(200);
    // el ciclo de vida es de la plataforma
    expect(
      (
        await app.post(
          '/axeda/company/set-status',
          { id: acme.id, version: 2, status: 'inactive' },
          boss.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.post(
          '/axeda/company/delete',
          { id: acme.id, version: 2, immediate: true },
          boss.cookie,
        )
      ).status,
    ).toBe(403);
    expect((await app.get('/axeda/company/list', boss.cookie, { deleted: 'include' })).status).toBe(
      403,
    );
  });

  it('a deactivated company silences its people on the very next request', async () => {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');
    const reader = await role(app, admin.cookie, 'reader', ['invoice:read']);
    const alice = await app.signUp('alice');
    ok(
      await app.post(
        '/axeda/assignment/create',
        { userId: alice.id, roleId: reader.id, scope: { type: 'company', id: acme.id } },
        admin.cookie,
      ),
    );
    const core = app.plugin.instance();
    const target = { type: 'company', companyId: acme.id } as const;
    expect(await core.can({ userId: alice.id }, 'invoice:read', target)).toBe(true);

    ok(
      await app.post(
        '/axeda/company/set-status',
        { id: acme.id, version: 1, status: 'inactive' },
        admin.cookie,
      ),
    );
    expect(await core.can({ userId: alice.id }, 'invoice:read', target)).toBe(false);
    expect((await app.get('/axeda/company/list', alice.cookie)).json.items).toEqual([]);
  });
});

describe('businesses over HTTP', () => {
  it('a company admin creates businesses, assigns people to them, and cannot touch other companies’', async () => {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');
    const globex = await company(app, admin.cookie, 'globex');
    const adminRole = await role(app, admin.cookie, 'company-admin', [
      'axeda:business:manage',
      'axeda:assignment:manage',
      'invoice:*',
    ]);
    const cashierRole = await role(app, admin.cookie, 'cashier', ['invoice:read']);
    const boss = await app.signUp('boss');
    const cashier = await app.signUp('cashier');
    ok(
      await app.post(
        '/axeda/assignment/create',
        { userId: boss.id, roleId: adminRole.id, scope: { type: 'company', id: acme.id } },
        admin.cookie,
      ),
    );

    const shop = ok(
      await app.post(
        '/axeda/business/create',
        { companyId: acme.id, slug: 'shop', name: 'Shop' },
        boss.cookie,
      ),
    ) as { id: string; companyId: string; version: number };
    expect(shop.companyId).toBe(acme.id);
    expect(
      (
        await app.post(
          '/axeda/business/create',
          { companyId: globex.id, slug: 'x', name: 'X' },
          boss.cookie,
        )
      ).status,
    ).toBe(404);

    // asignar a un negocio: la compañía sale de la base de datos
    const assigned = await app.post(
      '/axeda/assignment/create',
      { userId: cashier.id, roleId: cashierRole.id, scope: { type: 'business', id: shop.id } },
      boss.cookie,
    );
    expect(assigned.status).toBe(200);
    const foreign = ok(
      await app.post(
        '/axeda/business/create',
        { companyId: globex.id, slug: 'far', name: 'Far' },
        admin.cookie,
      ),
    ) as { id: string };
    const denied = await app.post(
      '/axeda/assignment/create',
      { userId: cashier.id, roleId: cashierRole.id, scope: { type: 'business', id: foreign.id } },
      boss.cookie,
    );
    expect([denied.status, denied.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);

    const core = app.plugin.instance();
    const at = { type: 'business', companyId: acme.id, businessId: shop.id } as const;
    expect(await core.can({ userId: cashier.id }, 'invoice:read', at)).toBe(true);

    // el negocio solo lo ve su gente; el cajero ve su negocio y nada más
    const list = await app.get('/axeda/business/list', cashier.cookie, { companyId: acme.id });
    expect(list.json.items.map((item: { slug: string }) => item.slug)).toEqual(['shop']);
    expect((await app.get('/axeda/business/get', boss.cookie, { id: foreign.id })).status).toBe(
      404,
    );

    ok(
      await app.post(
        '/axeda/business/set-status',
        { id: shop.id, version: shop.version, status: 'inactive' },
        boss.cookie,
      ),
    );
    expect(await core.can({ userId: cashier.id }, 'invoice:read', at)).toBe(false);
  });
});

describe('invitations over HTTP', () => {
  async function invited() {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');
    const inviterRole = await role(app, admin.cookie, 'company-admin', [
      'axeda:invitation:manage',
      'invoice:*',
    ]);
    const cashierRole = await role(app, admin.cookie, 'cashier', ['invoice:read']);
    const boss = await app.signUp('boss');
    ok(
      await app.post(
        '/axeda/assignment/create',
        { userId: boss.id, roleId: inviterRole.id, scope: { type: 'company', id: acme.id } },
        admin.cookie,
      ),
    );
    const sent = ok(
      await app.post(
        '/axeda/invitation/create',
        {
          email: 'Guest@Test.dev',
          scope: { type: 'company', id: acme.id },
          roleIds: [cashierRole.id],
        },
        boss.cookie,
      ),
    ) as { id: string; email: string };
    return { app, admin, acme, boss, cashierRole, sent, message: app.sent.at(-1) };
  }

  it('is delivered with a link built from the configured URL, never from the request', async () => {
    const { app, message, sent } = await invited();
    expect(message?.email).toBe('guest@test.dev');
    expect(message?.link.startsWith('https://app.example/accept?token=')).toBe(true);
    expect(decodeURIComponent(message?.link.split('token=')[1] ?? '')).toBe(message?.token);
    expect(sent.email).toBe('guest@test.dev');
    // Una petición con una cabecera Host falsa no cambia el enlace.
    const spoofed = await app.auth.handler(
      new Request(`${BASE_URL}/api/auth/axeda/me`, {
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
      }),
    );
    expect(spoofed.status).toBe(401);
    expect(app.sent.every((m) => m.link.startsWith('https://app.example/'))).toBe(true);
  });

  it('never exposes the secret or its hash through the API', async () => {
    const { app, boss, acme, sent, message } = await invited();
    const list = await app.get('/axeda/invitation/list', boss.cookie, {
      scopeType: 'company',
      scopeId: acme.id,
    });
    expect(list.status).toBe(200);
    const text = JSON.stringify([sent, list.json]);
    expect(text).not.toMatch(/secret|hash|token/i);
    expect(text).not.toContain(message?.token.split('.')[1] ?? 'impossible');
    expect(Object.keys(list.json.items[0]).sort()).toEqual([
      'acceptedAt',
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedBy',
      'revokedAt',
      'roleIds',
      'scope',
    ]);
  });

  it('the invited person signs up, verifies the email and accepts; the token works once', async () => {
    const { app, message, acme } = await invited();
    const guest = await app.signUp('guest');
    // cuenta con el correo correcto pero SIN verificar: no vale
    const early = await app.post(
      '/axeda/invitation/accept',
      { token: message?.token },
      guest.cookie,
    );
    expect([early.status, early.json.code]).toEqual([400, 'AXEDA_INVITATION_INVALID']);

    await verifyEmail(app, guest.id);
    const accepted = await app.post(
      '/axeda/invitation/accept',
      { token: message?.token },
      guest.cookie,
    );
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json.assignments).toHaveLength(1);
    expect(accepted.json.assignments[0]).toMatchObject({
      userId: guest.id,
      scope: { type: 'company', id: acme.id },
    });

    const me = await app.get('/axeda/me', guest.cookie);
    expect(me.json.assignments).toHaveLength(1);
    const twice = await app.post(
      '/axeda/invitation/accept',
      { token: message?.token },
      guest.cookie,
    );
    expect(twice.status).toBe(400);
  });

  it('a different verified account cannot use the link', async () => {
    const { app, message } = await invited();
    const mallory = await app.signUp('mallory');
    await verifyEmail(app, mallory.id);
    const response = await app.post(
      '/axeda/invitation/accept',
      { token: message?.token },
      mallory.cookie,
    );
    expect([response.status, response.json.code]).toEqual([400, 'AXEDA_INVITATION_INVALID']);
    expect((await app.get('/axeda/me', mallory.cookie)).json.assignments).toEqual([]);
  });

  it('can be revoked by the inviter, after which the link is dead', async () => {
    const { app, boss, sent, message } = await invited();
    ok(await app.post('/axeda/invitation/revoke', { id: sent.id }, boss.cookie));
    const guest = await app.signUp('guest');
    await verifyEmail(app, guest.id);
    expect(
      (await app.post('/axeda/invitation/accept', { token: message?.token }, guest.cookie)).status,
    ).toBe(400);
  });

  it('is disabled (501) when the application configured no delivery', async () => {
    const app = await createHttpApp({ withoutInvitations: true });
    const admin = await app.signUp('admin');
    await app.plugin.instance().bootstrap({ userId: admin.id });
    const r = await role(app, admin.cookie, 'r', ['invoice:read']);
    const response = await app.post(
      '/axeda/invitation/create',
      { email: 'x@test.dev', scope: { type: 'global' }, roleIds: [r.id] },
      admin.cookie,
    );
    expect([response.status, response.json.code]).toEqual([501, 'AXEDA_FEATURE_DISABLED']);
  });
});

describe('public identity', () => {
  it('answers without a session, with the whitelisted fields only', async () => {
    const { app, admin } = await world();
    ok(
      await app.post(
        '/axeda/company/create',
        {
          slug: 'acme',
          name: 'ACME',
          legalName: 'Secret Legal',
          logoUrl: 'https://cdn.example/a.png',
          metadata: { internal: 'x' },
        },
        admin.cookie,
      ),
    );
    const response = await app.get('/axeda/public/identity', undefined, { company: 'acme' });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      kind: 'company',
      slug: 'acme',
      name: 'ACME',
      logoUrl: 'https://cdn.example/a.png',
      faviconUrl: null,
    });
    expect(JSON.stringify(response.json)).not.toMatch(/Secret|internal/);
  });

  it('answers 404 alike for unknown, inactive and deleted ones', async () => {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');
    const shop = ok(
      await app.post(
        '/axeda/business/create',
        { companyId: acme.id, slug: 'shop', name: 'Shop' },
        admin.cookie,
      ),
    ) as { id: string };
    expect(
      (await app.get('/axeda/public/identity', undefined, { company: 'acme', business: 'shop' }))
        .json.kind,
    ).toBe('business');

    const unknown = await app.get('/axeda/public/identity', undefined, { company: 'nope' });
    ok(
      await app.post(
        '/axeda/business/set-status',
        { id: shop.id, version: 1, status: 'inactive' },
        admin.cookie,
      ),
    );
    const inactive = await app.get('/axeda/public/identity', undefined, {
      company: 'acme',
      business: 'shop',
    });
    ok(await app.post('/axeda/company/delete', { id: acme.id, version: 1 }, admin.cookie));
    const deleted = await app.get('/axeda/public/identity', undefined, { company: 'acme' });
    for (const response of [unknown, inactive, deleted]) {
      expect(response.status).toBe(404);
      expect(response.json.code).toBe('AXEDA_COMPANY_NOT_FOUND');
    }
    expect(new Set([unknown, inactive, deleted].map((r) => r.json.message)).size).toBe(1);
  });

  it('is off unless the application turns it on', async () => {
    const app = await createHttpApp({ plugin: { publicIdentity: false } });
    const admin = await app.signUp('admin');
    await app.plugin.instance().bootstrap({ userId: admin.id });
    ok(await app.post('/axeda/company/create', { slug: 'acme', name: 'ACME' }, admin.cookie));
    expect((await app.get('/axeda/public/identity', undefined, { company: 'acme' })).status).toBe(
      404,
    );
  });

  it('has its own, stricter rate limit', async () => {
    const { app } = await world();
    const rules = app.plugin.rateLimit;
    const publicRule = rules.find((rule) => rule.pathMatcher('/axeda/public/identity'));
    const adminRule = rules.find((rule) => rule.pathMatcher('/axeda/role/create'));
    expect(publicRule?.max).toBeLessThan(adminRule?.max ?? 0);
  });

  it('rejects unknown query parameters', async () => {
    const { app } = await world();
    expect(
      (await app.get('/axeda/public/identity', undefined, { company: 'acme', surprise: '1' }))
        .status,
    ).toBe(400);
  });
});

describe('purging deleted companies', () => {
  it('removes a company whose grace period ended, with its businesses and assignments', async () => {
    const { app, admin } = await world();
    const acme = await company(app, admin.cookie, 'acme');
    const shop = ok(
      await app.post(
        '/axeda/business/create',
        { companyId: acme.id, slug: 'shop', name: 'Shop' },
        admin.cookie,
      ),
    ) as { id: string };
    const reader = await role(app, admin.cookie, 'reader', ['invoice:read']);
    const alice = await app.signUp('alice');
    ok(
      await app.post(
        '/axeda/assignment/create',
        { userId: alice.id, roleId: reader.id, scope: { type: 'business', id: shop.id } },
        admin.cookie,
      ),
    );
    ok(await app.post('/axeda/company/delete', { id: acme.id, version: 1 }, admin.cookie));

    const persistence = app.plugin.persistence();
    // Con la gracia vigente no se borra nada.
    expect(await app.plugin.instance().purgeDeleted()).toEqual({ companies: 0, businesses: 0 });
    // Se simula que pasó el plazo moviendo la fecha de borrado al pasado.
    const context = await app.auth.$context;
    await context.adapter.update({
      model: 'axedaCompany',
      where: [{ field: 'id', value: acme.id }],
      update: { deletedAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    const result = await app.plugin.instance().purgeDeleted();
    expect(result.companies).toBe(1);
    expect(await persistence.companies.get(acme.id)).toBeNull();
    expect(await persistence.businesses.get(shop.id)).toBeNull();
    expect(await persistence.assignments.countForUser(alice.id)).toBe(0);
  });
});
