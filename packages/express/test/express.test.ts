import { afterEach, describe, expect, it } from 'vitest';
import { isAxedaError, type Principal } from '@axeda/core';
import { createAxedaExpress, globalScope, resolveScope, type AxedaExpress } from '../src/index.js';
import { APP, EVIL, closeAll, startApp } from './support/app.js';

afterEach(closeAll);

const FORBIDDEN = { code: 'AXEDA_FORBIDDEN', message: 'You are not allowed to do that.' };

describe('authentication', () => {
  it('lets public routes through and answers 401 to protected ones without a session', async () => {
    const t = await startApp();
    expect((await t.call('/public')).status).toBe(200);
    const anonymous = await t.call('/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({ code: 'AXEDA_UNAUTHENTICATED' });
    expect((await t.call('/reports')).status).toBe(401);
  });

  it('does not accept a forged or malformed cookie', async () => {
    const t = await startApp();
    for (const cookie of [
      'better-auth.session_token=forged',
      'better-auth.session_token=x.y',
      'garbage',
    ]) {
      expect((await t.call('/me', { cookie })).status).toBe(401);
    }
  });

  it('identifies the caller from a real session and records the request data', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const reply = await t.call('/me', { cookie: ana.cookie });
    expect(reply.status).toBe(200);
    expect(reply.body['userId']).toBe(ana.id);
    expect(reply.body['ip']).toEqual(expect.any(String));
  });

  it('asks for the session once per request, however many middlewares are chained', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    t.sessionLookups.count = 0;
    expect((await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(200);
    expect(t.sessionLookups.count).toBe(1);

    t.sessionLookups.count = 0;
    expect((await t.call(`/chain/${acme}`, { cookie: ana.cookie })).status).toBe(200);
    expect(t.sessionLookups.count).toBe(1);
  });

  it('answers 500 and never runs the route when the session lookup fails', async () => {
    const t = await startApp({
      principal: () => async () => {
        throw new Error('session store is down');
      },
    });
    const reply = await t.call('/reports');
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ code: 'INTERNAL' });
  });
});

describe('permissions are checked where the route says', () => {
  it('allows a company role in that company and nowhere else', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });

    expect((await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(200);
    const other = await t.call(`/companies/${globex}/invoices`, { cookie: ana.cookie });
    expect(other.status).toBe(403);
    expect(other.body).toEqual(FORBIDDEN);
    // Una función de compañía no vale en las rutas globales.
    expect((await t.call('/reports', { cookie: ana.cookie })).status).toBe(403);
  });

  it('a permission she lacks is denied even inside her own company', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    const write = await t.call(`/companies/${acme}/invoices`, {
      method: 'POST',
      cookie: ana.cookie,
      origin: APP,
      body: {},
    });
    expect(write.status).toBe(403);
  });

  it('a global administrator reaches every company', async () => {
    const t = await startApp();
    const boss = await t.signUp('boss');
    await t.give(boss.id, ['*'], { type: 'global' });
    const acme = await t.company('acme');
    expect((await t.call(`/companies/${acme}/invoices`, { cookie: boss.cookie })).status).toBe(200);
    expect((await t.call('/reports', { cookie: boss.cookie })).status).toBe(200);
  });

  it('revocation is immediate: the next request is denied', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    expect((await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(200);

    const [assignment] = await t.core.assignments.listForUser(t.root, ana.id);
    await t.core.assignments.revoke(t.root, assignment?.id ?? '');
    expect((await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(403);
  });

  it('an inactive company denies everything inside it', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    const company = await t.core.companies.get(t.root, acme);
    await t.core.companies.setStatus(t.root, acme, company.version, 'inactive');
    expect((await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(403);
  });

  it('a banned user loses access at once, even with a session cookie', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    await t.core.users.ban(t.root, ana.id, { reason: 'abuse' });
    const reply = await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie });
    expect(reply.status).toBe(401);
  });

  it('a banned principal that reaches the route another way is denied', async () => {
    const t = await startApp({
      principal: (real) => async (request) => {
        const principal = await real(request);
        return principal === null ? null : ({ ...principal, banned: true } satisfies Principal);
      },
    });
    const boss = await t.signUp('boss');
    await t.give(boss.id, ['*'], { type: 'global' });
    expect((await t.call('/reports', { cookie: boss.cookie })).status).toBe(403);
  });
});

describe('business routes: the company comes from the database, never from the request', () => {
  it('allows a business role on that business, with or without the company in the path', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const shop = await t.business('shop', acme);
    await t.give(ana.id, ['invoice:read'], { type: 'business', id: shop });
    expect((await t.call(`/businesses/${shop}/invoices`, { cookie: ana.cookie })).status).toBe(200);
    const nested = `/companies/${acme}/businesses/${shop}/invoices`;
    expect((await t.call(nested, { cookie: ana.cookie })).status).toBe(200);
  });

  it('a business under another company in the path is denied, with the same answer', async () => {
    const t = await startApp();
    const boss = await t.signUp('boss');
    await t.give(boss.id, ['*'], { type: 'global' });
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    const shop = await t.business('shop', acme);

    const mismatch = await t.call(`/companies/${globex}/businesses/${shop}/invoices`, {
      cookie: boss.cookie,
    });
    // Ni siquiera un administrador global recibe datos de un negocio por la compañía equivocada.
    expect(mismatch.status).toBe(403);
    expect(mismatch.body).toEqual(FORBIDDEN);
  });

  it('a company role does not leak into another company’s business', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    const shop = await t.business('shop', globex);
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    expect((await t.call(`/businesses/${shop}/invoices`, { cookie: ana.cookie })).status).toBe(403);
  });
});

describe('what a denial reveals', () => {
  it('answers the same whether the company exists or not', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });

    const exists = await t.call(`/companies/${globex}/invoices`, { cookie: ana.cookie });
    const missing = await t.call('/companies/no-such-company/invoices', { cookie: ana.cookie });
    expect(exists.status).toBe(missing.status);
    expect(exists.body).toEqual(missing.body);
  });

  it('can answer 404 instead of 403, equally for missing and for someone else’s', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });

    expect((await t.call(`/hidden/${acme}`, { cookie: ana.cookie })).status).toBe(200);
    const exists = await t.call(`/hidden/${globex}`, { cookie: ana.cookie });
    const missing = await t.call('/hidden/nope', { cookie: ana.cookie });
    expect(exists.status).toBe(404);
    expect(exists.body).toEqual(missing.body);
  });

  it('never lets a shared cache keep an authorization answer', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    for (const reply of [await t.call('/me'), await t.call('/reports', { cookie: ana.cookie })]) {
      expect(reply.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('a malformed scope is denied, not guessed', () => {
  it('rejects repeated, empty, missing and oversized identifiers', async () => {
    const t = await startApp();
    const boss = await t.signUp('boss');
    await t.give(boss.id, ['*'], { type: 'global' });
    const acme = await t.company('acme');
    const cookie = boss.cookie;

    expect((await t.call(`/invoices?companyId=${acme}`, { cookie })).status).toBe(200);
    for (const query of [
      `?companyId=${acme}&companyId=${acme}`,
      '?companyId=',
      '',
      `?companyId=${'x'.repeat(300)}`,
      '?companyId[a]=1',
    ]) {
      const reply = await t.call(`/invoices${query}`, { cookie });
      expect(reply.status, query).toBe(403);
    }
  });

  it('resolveScope reads exactly what it was told to', () => {
    const request = (params: Record<string, unknown>, query: Record<string, unknown> = {}) => ({
      params,
      query,
    });
    expect(resolveScope({ company: 'c' })(request({ c: 'a' }))).toEqual({
      kind: 'scope',
      scope: { type: 'company', id: 'a' },
    });
    expect(resolveScope({ company: 'c' })(request({}, { c: 'a' }))).toEqual({ kind: 'invalid' });
    expect(resolveScope({ company: 'c', from: 'query' })(request({}, { c: 'a' }))).toMatchObject({
      kind: 'scope',
    });
    expect(resolveScope({ company: 'c', business: 'b' })(request({ c: 'a' }))).toEqual({
      kind: 'invalid',
    });
    expect(resolveScope({ company: 'c', business: 'b' })(request({ b: 'x' }))).toEqual({
      kind: 'invalid',
    });
    expect(resolveScope({ business: 'b' })(request({ b: 'x', c: 'ignored' }))).toEqual({
      kind: 'scope',
      scope: { type: 'business', id: 'x' },
    });
    // Solo vale un texto no vacío y corto: nada de arreglos, objetos ni números.
    for (const value of [['a'], ['a', 'b'], { a: 1 }, 7, null, '', 'x'.repeat(256)]) {
      expect(resolveScope({ company: 'c' })(request({ c: value })), String(value)).toEqual({
        kind: 'invalid',
      });
    }
    expect(resolveScope({ company: 'c' })(request({ c: 'x'.repeat(255) })).kind).toBe('scope');
    expect(resolveScope({})(request({}))).toEqual({ kind: 'global' });
    expect(globalScope(request({}))).toEqual({ kind: 'global' });
  });
});

describe('CSRF: writes that carry a cookie must come from a trusted origin', () => {
  async function setup() {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:create'], { type: 'company', id: acme });
    return { t, ana, path: `/companies/${acme}/invoices` };
  }

  it('accepts a trusted origin', async () => {
    const { t, ana, path } = await setup();
    const reply = await t.call(path, { method: 'POST', cookie: ana.cookie, origin: APP, body: {} });
    expect(reply.status).toBe(201);
  });

  it('refuses an untrusted origin, a missing origin and "null"', async () => {
    const { t, ana, path } = await setup();
    for (const origin of [EVIL, null, 'null', 'not-a-url', `${APP}.evil.net`]) {
      const reply = await t.call(path, { method: 'POST', cookie: ana.cookie, origin, body: {} });
      expect(reply.status, String(origin)).toBe(403);
      expect(reply.body).toMatchObject({ code: 'AXEDA_CROSS_SITE' });
    }
  });

  it('does not touch reads, which cannot change anything', async () => {
    const { t, ana } = await setup();
    expect((await t.call('/me', { cookie: ana.cookie, origin: EVIL })).status).toBe(200);
  });

  it('applies to requireAuth too', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const hostile = await t.call('/me', { method: 'POST', cookie: ana.cookie, origin: EVIL });
    expect(hostile.status).toBe(403);
    expect(hostile.body).toMatchObject({ code: 'AXEDA_CROSS_SITE' });
    const own = await t.call('/me', { method: 'POST', cookie: ana.cookie, origin: APP });
    expect(own.status).toBe(200);
  });

  it('can be switched off explicitly for cookie-less APIs', async () => {
    const t = await startApp({ csrf: false });
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    await t.give(ana.id, ['invoice:create'], { type: 'company', id: acme });
    const reply = await t.call(`/companies/${acme}/invoices`, {
      method: 'POST',
      cookie: ana.cookie,
      origin: EVIL,
      body: {},
    });
    expect(reply.status).toBe(201);
  });
});

describe('scopeFilter', () => {
  it('tells the route where the caller has the permission, for filtering its queries', async () => {
    const t = await startApp();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    const shop = await t.business('shop', globex);
    await t.give(ana.id, ['invoice:read'], { type: 'company', id: acme });
    await t.give(ana.id, ['invoice:read'], { type: 'business', id: shop });
    const reply = await t.call('/mine', { cookie: ana.cookie });
    expect(reply.body).toEqual({ unrestricted: false, companyIds: [acme], businessIds: [shop] });
  });
});

describe('mistakes fail when the route is declared, not in production', () => {
  async function express(): Promise<AxedaExpress> {
    const t = await startApp();
    return t.x;
  }

  it('rejects a permission that is not in the catalog, and wildcards', async () => {
    const x = await express();
    expect(() => x.requirePermission('invoice:raed')).toThrowError(/not in the permission catalog/);
    expect(() => x.requirePermission('invoice:*')).toThrowError(/wildcard/);
    expect(() => x.requirePermission('')).toThrow();
  });

  it('principalOf is only available behind requireAuth() or requirePermission()', async () => {
    const x = await express();
    try {
      x.principalOf({} as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAxedaError(error, 'AXEDA_INVALID_CONFIG')).toBe(true);
    }
  });

  it('forces a decision about CSRF', async () => {
    const t = await startApp();
    const base = { axeda: t.core, principal: async () => null };
    const bad = (extra: object) => () =>
      createAxedaExpress({ ...base, ...extra } as unknown as Parameters<
        typeof createAxedaExpress
      >[0]);
    expect(bad({ trustedOrigins: [] })).toThrowError(/trustedOrigins is empty/);
    expect(bad({ trustedOrigins: ['https://*.example.com'] })).toThrowError(/must be an origin/);
    expect(bad({ trustedOrigins: ['https://app.example.com/path'] })).toThrowError(
      /must be an origin/,
    );
    expect(bad({ trustedOrigins: ['nope'] })).toThrowError(/must be an origin/);
    expect(bad({ csrf: false })).not.toThrow();
  });
});
