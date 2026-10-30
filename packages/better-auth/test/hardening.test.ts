import { describe, expect, it } from 'vitest';
import { BASE_URL, createHttpApp, type HttpApp } from './support/http.js';

/** Pruebas de los controles que ASVS pide sobre la superficie HTTP del plugin. */

async function world() {
  const app = await createHttpApp();
  const admin = await app.signUp('admin');
  const nobody = await app.signUp('nobody');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  return { app, admin, nobody };
}

const send = (
  app: HttpApp,
  path: string,
  init: { method?: string; cookie?: string; body?: string },
) =>
  app.auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: init.method ?? 'GET',
      headers: {
        origin: BASE_URL,
        ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );

describe('nothing the plugin answers can be cached (ASVS V14.3.2)', () => {
  it('sends Cache-Control: no-store on every endpoint, for any caller and any outcome', async () => {
    const { app, admin, nobody } = await world();
    const endpoints = Object.values(app.plugin.endpoints).map((endpoint) => ({
      path: endpoint.path as string,
      method: (endpoint.options as { method: string }).method,
    }));
    expect(endpoints.length).toBeGreaterThan(30);

    const outcomes = new Set<number>();
    for (const { path, method } of endpoints) {
      for (const cookie of [undefined, nobody.cookie, admin.cookie]) {
        const response = await send(app, path, {
          method,
          ...(cookie === undefined ? {} : { cookie }),
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        outcomes.add(response.status);
        expect(
          response.headers.get('cache-control'),
          `${method} ${path} -> ${response.status}`,
        ).toBe('no-store');
      }
    }
    // Se probaron respuestas correctas, de validación, sin sesión y sin permiso.
    expect([...outcomes].some((status) => status === 200)).toBe(true);
    expect([...outcomes].some((status) => status === 400)).toBe(true);
    expect([...outcomes].some((status) => status === 401)).toBe(true);
    expect([...outcomes].some((status) => status === 403)).toBe(true);
  });

  it('does not touch the responses of Better Auth itself', async () => {
    const { app } = await world();
    const response = await send(app, '/ok', {});
    expect(response.headers.get('cache-control')).not.toBe('no-store');
  });
});

describe('prototype pollution (ASVS V15.3.6)', () => {
  const attempts = [
    '{"key":"x","name":"X","permissions":[],"__proto__":{"polluted":"yes"}}',
    '{"key":"x","name":"X","permissions":[],"constructor":{"prototype":{"polluted":"yes"}}}',
    '{"__proto__":{"polluted":"yes"}}',
  ];

  it.each(attempts)('is refused and leaves Object.prototype alone: %s', async (body) => {
    const { app, admin } = await world();
    const response = await send(app, '/axeda/role/create', {
      method: 'POST',
      cookie: admin.cookie,
      body,
    });
    expect(response.status).toBe(400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});

describe('HTTP parameter pollution (ASVS V15.3.7)', () => {
  it.each([
    '?limit=1&limit=2',
    '?limit=5&limit=abc',
    '?limit[]=5',
    '?cursor=a&cursor=b',
    '?scopeType=global&scopeType=company',
    '?scopeId=a&scopeId=b&scopeType=company',
  ])('a repeated or malformed parameter is a 400, never a guess: %s', async (query) => {
    const { app, admin } = await world();
    for (const path of ['/axeda/role/list', '/axeda/audit/list', '/axeda/invitation/list']) {
      const response = await send(app, path + query, { cookie: admin.cookie });
      expect(response.status, `${path}${query}`).toBe(400);
    }
  });
});
