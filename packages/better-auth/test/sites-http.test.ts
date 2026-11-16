import { describe, expect, it } from 'vitest';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

interface Created {
  id: string;
  version: number;
}

/**
 * Una compañía con un negocio, una sede directa y otra del negocio; un empleado en la sede del
 * negocio. Todo por HTTP, como lo haría una aplicación.
 */
async function world(kind: (typeof databaseKinds)[number]) {
  const app = await createHttpApp({ kind });
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  const post = (path: string, body: unknown, cookie = admin.cookie) =>
    app.post(path, body, cookie).then(ok) as Promise<Created & Record<string, unknown>>;

  const company = await post('/axeda/company/create', { slug: 'acme', name: 'ACME' });
  const business = await post('/axeda/business/create', {
    companyId: company.id,
    slug: 'shop',
    name: 'Shop',
  });
  const direct = await post('/axeda/site/create', {
    companyId: company.id,
    slug: 'hq',
    name: 'Headquarters',
  });
  const inShop = await post('/axeda/site/create', {
    companyId: company.id,
    businessId: business.id,
    slug: 'north',
    name: 'North',
    metadata: { city: 'Monterrey' },
  });
  return { app, admin, post, company, business, direct, inShop };
}

const slugsOf = (page: unknown) => (page as { items: { slug: string }[] }).items.map((s) => s.slug);

describe.each(databaseKinds)('sites over HTTP (%s)', (kind) => {
  it('creates sites under a company or a business, and returns only the documented fields', async () => {
    const { app, admin, company, business, inShop } = await world(kind);
    const got = ok(await app.get('/axeda/site/get', admin.cookie, { id: inShop.id }));
    expect(Object.keys(got).sort()).toEqual([
      'businessId',
      'companyId',
      'createdAt',
      'deletedAt',
      'faviconUrl',
      'id',
      'logoUrl',
      'metadata',
      'name',
      'slug',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(got).toMatchObject({
      companyId: company.id,
      businessId: business.id,
      metadata: { city: 'Monterrey' },
    });
  });

  it('lists all the sites, those of one business, or those that hang directly from the company', async () => {
    const { app, admin, company, business } = await world(kind);
    const list = (query: Record<string, string> = {}) =>
      app.get('/axeda/site/list', admin.cookie, { companyId: company.id, ...query }).then(ok);
    expect(slugsOf(await list())).toEqual(['hq', 'north']);
    expect(slugsOf(await list({ businessId: business.id }))).toEqual(['north']);
    expect(slugsOf(await list({ businessId: 'none' }))).toEqual(['hq']);
  });

  it('gives an employee the permissions of their site, and tells the frontend what they may do there', async () => {
    const { app, post, inShop, direct } = await world(kind);
    const lead = await app.signUp('lead');
    const role = await post('/axeda/role/create', {
      key: 'site-lead',
      name: 'Site lead',
      permissions: ['axeda:assignment:manage', 'invoice:read'],
    });
    await post('/axeda/assignment/create', {
      userId: lead.id,
      roleId: role.id,
      scope: { type: 'site', id: inShop.id },
    });

    const me = (query?: Record<string, string>) =>
      app.get('/axeda/me', lead.cookie, query).then(ok);
    expect(await me({ scopeType: 'site', scopeId: inShop.id })).toMatchObject({
      permissions: ['axeda:assignment:manage', 'invoice:read'],
    });
    // Otra sede, o una que no existe: lista vacía, sin distinguir una de otra.
    expect(await me({ scopeType: 'site', scopeId: direct.id })).toMatchObject({ permissions: [] });
    expect(await me({ scopeType: 'site', scopeId: 'missing' })).toMatchObject({ permissions: [] });
    // Sin lugar, la respuesta es la de siempre.
    const plain = await me();
    expect(plain).not.toHaveProperty('permissions');
    expect(plain).toMatchObject({ globalPermissions: [] });

    // Sus empleados: los de su sede sí, los de otra no.
    const employees = ok(
      await app.get('/axeda/assignment/list', lead.cookie, {
        scopeType: 'site',
        scopeId: inShop.id,
      }),
    ) as { items: { userId: string }[] };
    expect(employees.items.map((a) => a.userId)).toEqual([lead.id]);
    const elsewhere = await app.get('/axeda/assignment/list', lead.cookie, {
      scopeType: 'site',
      scopeId: direct.id,
    });
    expect(elsewhere.status).toBe(403);
  });

  it('hides a site from someone outside it, and refuses changes from an employee', async () => {
    const { app, post, inShop, direct } = await world(kind);
    const worker = await app.signUp('worker');
    const role = await post('/axeda/role/create', {
      key: 'clerk',
      name: 'Clerk',
      permissions: ['invoice:read'],
    });
    await post('/axeda/assignment/create', {
      userId: worker.id,
      roleId: role.id,
      scope: { type: 'site', id: inShop.id },
    });
    expect((await app.get('/axeda/site/get', worker.cookie, { id: direct.id })).json).toMatchObject(
      { code: 'AXEDA_SITE_NOT_FOUND' },
    );
    const rename = await app.post(
      '/axeda/site/update',
      { id: inShop.id, version: inShop.version, name: 'Mine' },
      worker.cookie,
    );
    expect([rename.status, (rename.json as { code: string }).code]).toEqual([
      403,
      'AXEDA_FORBIDDEN',
    ]);
  });
});
