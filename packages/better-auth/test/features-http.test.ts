import { describe, expect, it } from 'vitest';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

describe.each(databaseKinds)('features over HTTP (%s)', (kind) => {
  async function world() {
    const app = await createHttpApp({
      kind,
      plugin: { features: { inventory: { permissions: ['invoice:*'], name: 'Invoices module' } } },
    });
    const admin = await app.signUp('admin');
    await app.plugin.instance().bootstrap({ userId: admin.id });
    const post = (path: string, body: unknown, cookie = admin.cookie) =>
      app.post(path, body, cookie).then(ok) as Promise<{ id: string }>;
    const acme = await post('/axeda/company/create', { slug: 'acme', name: 'ACME' });
    const globex = await post('/axeda/company/create', { slug: 'globex', name: 'Globex' });
    const role = await post('/axeda/role/create', {
      key: 'clerk',
      name: 'Clerk',
      permissions: ['invoice:read', 'axeda:company:manage'],
    });
    const clerk = await app.signUp('clerk');
    for (const company of [acme, globex]) {
      await post('/axeda/assignment/create', {
        userId: clerk.id,
        roleId: role.id,
        scope: { type: 'company', id: company.id },
      });
    }
    const permissionsIn = async (companyId: string) =>
      (
        ok(
          await app.get('/axeda/me', clerk.cookie, { scopeType: 'company', scopeId: companyId }),
        ) as { permissions: string[] }
      ).permissions;
    return { app, admin, clerk, acme, globex, permissionsIn };
  }

  it('lets the platform switch a feature on for one company, which unlocks its permissions there', async () => {
    const { app, admin, clerk, acme, globex, permissionsIn } = await world();
    expect(await permissionsIn(acme.id)).toEqual(['axeda:company:manage']);
    const listed = ok(await app.get('/axeda/feature/list', clerk.cookie, { companyId: acme.id }));
    expect(listed).toEqual({
      items: [
        {
          key: 'inventory',
          name: 'Invoices module',
          description: null,
          enabled: false,
          source: 'default',
        },
      ],
    });

    const set = ok(
      await app.post(
        '/axeda/feature/set',
        { companyId: acme.id, feature: 'inventory', enabled: true },
        admin.cookie,
      ),
    );
    expect(set).toMatchObject({ key: 'inventory', enabled: true, source: 'set' });
    expect(await permissionsIn(acme.id)).toEqual(['axeda:company:manage', 'invoice:read']);
    expect(await permissionsIn(globex.id)).toEqual(['axeda:company:manage']);
  });

  it('refuses a company administrator who tries to switch it', async () => {
    const { app, clerk, acme } = await world();
    const response = await app.post(
      '/axeda/feature/set',
      { companyId: acme.id, feature: 'inventory', enabled: true },
      clerk.cookie,
    );
    expect([response.status, response.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
  });
});
