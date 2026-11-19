import { describe, expect, it } from 'vitest';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

interface Node {
  key: string;
  label: string;
  children: Node[];
}
const flat = (nodes: Node[]): string[] =>
  nodes.flatMap((node) => [`${node.key}:${node.label}`, ...flat(node.children)]);

describe.each(databaseKinds)('menu adjustments over HTTP (%s)', (kind) => {
  async function world() {
    const app = await createHttpApp({ kind });
    const admin = await app.signUp('admin');
    await app.plugin.instance().bootstrap({ userId: admin.id });
    const post = (path: string, body: unknown, cookie = admin.cookie) =>
      app.post(path, body, cookie).then(ok) as Promise<{ id: string }>;
    const acme = await post('/axeda/company/create', { slug: 'acme', name: 'ACME' });
    const reader = await post('/axeda/role/create', {
      key: 'reader',
      name: 'Reader',
      permissions: ['invoice:read', 'report:read', 'axeda:menu:manage'],
    });
    const ana = await app.signUp('ana');
    await post('/axeda/assignment/create', {
      userId: ana.id,
      roleId: reader.id,
      scope: { type: 'company', id: acme.id },
    });
    const menu = async (query: Record<string, string>) =>
      flat(
        (
          ok(await app.get('/axeda/menu', ana.cookie, { locale: 'en', ...query })) as {
            items: Node[];
          }
        ).items,
      );
    return { app, admin, ana, acme, menu };
  }

  it('renames globally, hides inside a company, and resets', async () => {
    const { app, admin, ana, acme, menu } = await world();
    const inAcme = { scopeType: 'company', scopeId: acme.id };
    const before = await menu(inAcme);
    expect(before).toContain('reports:Reports');

    const renamed = ok(
      await app.post(
        '/axeda/menu-adjustment/set',
        {
          level: { type: 'global' },
          itemKey: 'reports',
          label: { en: 'Analytics', es: 'Análisis' },
        },
        admin.cookie,
      ),
    );
    expect(Object.keys(renamed).sort()).toEqual([
      'companyId',
      'hidden',
      'itemKey',
      'labels',
      'order',
      'updatedAt',
      'updatedBy',
    ]);
    expect(await menu(inAcme)).toContain('reports:Analytics');

    ok(
      await app.post(
        '/axeda/menu-adjustment/set',
        { level: { type: 'company', id: acme.id }, itemKey: 'reports', hidden: true },
        ana.cookie,
      ),
    );
    expect((await menu(inAcme)).some((entry) => entry.startsWith('reports:'))).toBe(false);
    const listed = ok(
      await app.get('/axeda/menu-adjustment/list', ana.cookie, {
        scopeType: 'company',
        scopeId: acme.id,
      }),
    ) as { items: { itemKey: string; hidden: boolean }[] };
    expect(listed.items).toMatchObject([{ itemKey: 'reports', hidden: true }]);

    expect(
      ok(
        await app.post(
          '/axeda/menu-adjustment/reset',
          { level: { type: 'company', id: acme.id }, itemKey: 'reports' },
          ana.cookie,
        ),
      ),
    ).toEqual({ reset: true });
    expect(await menu(inAcme)).toContain('reports:Analytics');
  });

  it('does not let a company administrator adjust the menu of everyone', async () => {
    const { app, ana } = await world();
    const response = await app.post(
      '/axeda/menu-adjustment/set',
      { level: { type: 'global' }, itemKey: 'reports', hidden: true },
      ana.cookie,
    );
    expect([response.status, response.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
  });
});
