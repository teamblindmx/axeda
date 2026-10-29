import { createServer as createProbe, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createExample, listen, type ExampleApp } from '../src/app.js';
import { readConfig, type ExampleConfig } from '../src/config.js';

const SECRET = 'k3Jx9Qp2Zr7Lm4Vb8Nc1Td6Wy5Hs0Ga3Fe9Uo2Ri7Pq';
const PASSWORD = 'correct-horse-battery-12';
const FRONTEND = 'http://localhost:5173';

const cleanups: Array<() => Promise<void>> = [];

// Cada persona llega desde su propia dirección: los límites de peticiones son por IP, y el
// contador en memoria de Better Auth es del proceso, así que la numeración no se reinicia.
let addresses = 0;
const nextIp = () =>
  `10.${Math.floor(++addresses / 65536) % 256}.${Math.floor(addresses / 256) % 256}.${addresses % 256}`;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const probe = createProbe();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Reply {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
}

/** La API de ejemplo encendida de verdad, con SQLite en memoria y el correo de desarrollo. */
async function start() {
  const port = await freePort();
  const baseURL = `http://localhost:${port}`;
  const config: ExampleConfig = readConfig({
    NODE_ENV: 'development',
    PORT: String(port),
    BASE_URL: baseURL,
    TRUSTED_ORIGINS: FRONTEND,
    BETTER_AUTH_SECRET: SECRET,
    DATABASE_FILE: ':memory:',
  });
  const quiet = (...args: unknown[]) => void args;
  const original = console.error;
  console.error = quiet;
  const example: ExampleApp = await createExample(config);
  const server: Server = await listen(example.app, port);
  cleanups.push(async () => {
    console.error = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await example.close();
  });

  const send = async (
    url: string,
    init: { method?: string; cookie?: string; origin?: string; body?: unknown; ip?: string },
  ): Promise<Reply> => {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'x-forwarded-for': init.ip ?? nextIp(),
        origin: init.origin ?? baseURL,
        ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  };

  /** Para llamar a Better Auth y a los endpoints de Axeda (`/api/auth/axeda/...`). */
  const auth = (path: string, init: Parameters<typeof send>[1] = {}) =>
    send(`${baseURL}/api/auth${path}`, init);
  /** Para llamar a las rutas de la propia aplicación. */
  const api = (path: string, init: Parameters<typeof send>[1] = {}) =>
    send(`${baseURL}${path}`, init);

  const signIn = async (email: string) => {
    const ip = nextIp();
    const response = await fetch(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseURL, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return {
      status: response.status,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };

  /** Registro real: la cuenta no sirve hasta abrir el enlace que llega por correo. */
  const register = async (name: string, email = `${name}@example.com`) => {
    const signedUp = await auth('/sign-up/email', {
      method: 'POST',
      body: { email, name, password: PASSWORD },
    });
    expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(200);
    const mail = example.mailer as unknown as { outbox: Array<{ to: string; link: string }> };
    const link = mail.outbox.findLast(
      (item) => item.to === email && item.link.includes('verify-email'),
    );
    expect(link, `verification mail for ${email}`).toBeDefined();
    const verified = await fetch(link?.link ?? '', { redirect: 'manual' });
    expect([200, 302, 307]).toContain(verified.status);
    const session = await signIn(email);
    expect(session.status).toBe(200);
    const me = await auth('/get-session', { cookie: session.cookie });
    return { id: (me.body as { user: { id: string } }).user.id, email, cookie: session.cookie };
  };

  const outbox = (example.mailer as unknown as { outbox: Array<{ to: string; link: string }> })
    .outbox;
  return { baseURL, example, auth, api, register, signIn, outbox };
}

type Started = Awaited<ReturnType<typeof start>>;

/** Un administrador global de verdad: lo que hace `npm run bootstrap`. */
async function administrator(t: Started) {
  const admin = await t.register('admin');
  await t.example.axeda.bootstrap({ userId: admin.id });
  return admin;
}

async function roleId(t: Started, cookie: string, key: string): Promise<string> {
  const roles = await t.auth('/axeda/role/list', { cookie });
  const found = (roles.body.items as Array<{ id: string; key: string }>).find(
    (role) => role.key === key,
  );
  expect(found, `role ${key}`).toBeDefined();
  return found?.id ?? '';
}

async function company(t: Started, cookie: string, slug: string): Promise<string> {
  const created = await t.auth('/axeda/company/create', {
    method: 'POST',
    cookie,
    body: { slug, name: slug.toUpperCase() },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

async function assign(
  t: Started,
  cookie: string,
  userId: string,
  role: string,
  companyId: string,
): Promise<void> {
  const reply = await t.auth('/axeda/assignment/create', {
    method: 'POST',
    cookie,
    body: {
      userId,
      roleId: await roleId(t, cookie, role),
      scope: { type: 'company', id: companyId },
    },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
}

describe('from zero to a protected API, following the guide', () => {
  it('an unverified account cannot sign in; the verification mail unlocks it', async () => {
    const t = await start();
    const email = 'ana@example.com';
    await t.auth('/sign-up/email', {
      method: 'POST',
      body: { email, name: 'ana', password: PASSWORD },
    });
    expect((await t.signIn(email)).status).toBe(403);
    expect((await t.register('bea')).cookie).not.toBe('');
  });

  it('serves the health check and refuses protected routes without a session', async () => {
    const t = await start();
    expect((await t.api('/health')).status).toBe(200);
    expect((await t.api('/invoices')).status).toBe(401);
    expect((await t.api('/no-such-route')).body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the administrator sets everything up and a cashier works inside her company only', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const globex = await company(t, admin.cookie, 'globex');
    const ana = await t.register('ana');
    await assign(t, admin.cookie, ana.id, 'cashier', acme);

    // Puede crear y ver facturas de ACME…
    const created = await t.api(`/companies/${acme}/invoices`, {
      method: 'POST',
      cookie: ana.cookie,
      origin: FRONTEND,
      body: { customer: 'Initech', amount: 1500 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(
      (await t.api(`/companies/${acme}/invoices`, { cookie: ana.cookie })).body.items,
    ).toHaveLength(1);

    // …pero no borrarlas (la cajera no tiene `invoice:delete`) ni tocar otra compañía.
    const invoiceId = created.body.id as string;
    const del = await t.api(`/companies/${acme}/invoices/${invoiceId}`, {
      method: 'DELETE',
      cookie: ana.cookie,
      origin: FRONTEND,
    });
    expect(del.status).toBe(403);
    const other = await t.api(`/companies/${globex}/invoices`, { cookie: ana.cookie });
    expect(other.status).toBe(403);
    expect((await t.api('/invoices', { cookie: ana.cookie })).body.items).toHaveLength(1);
  });

  it('a list shows only what the caller may see; an administrator sees everything', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const globex = await company(t, admin.cookie, 'globex');
    for (const id of [acme, globex]) {
      await t.api(`/companies/${id}/invoices`, {
        method: 'POST',
        cookie: admin.cookie,
        origin: FRONTEND,
        body: { customer: id, amount: 10 },
      });
    }
    const ana = await t.register('ana');
    await assign(t, admin.cookie, ana.id, 'viewer', acme);
    const mine = await t.api('/invoices', { cookie: ana.cookie });
    expect((mine.body.items as Array<{ companyId: string }>).map((item) => item.companyId)).toEqual(
      [acme],
    );
    expect((await t.api('/invoices', { cookie: admin.cookie })).body.items).toHaveLength(2);
  });

  it('a manager of one company cannot delete another company’s invoice through her own route', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const globex = await company(t, admin.cookie, 'globex');
    const secret = await t.api(`/companies/${globex}/invoices`, {
      method: 'POST',
      cookie: admin.cookie,
      origin: FRONTEND,
      body: { customer: 'Globex client', amount: 99 },
    });
    const bea = await t.register('bea');
    await assign(t, admin.cookie, bea.id, 'manager', acme);

    const attempt = await t.api(`/companies/${acme}/invoices/${secret.body.id}`, {
      method: 'DELETE',
      cookie: bea.cookie,
      origin: FRONTEND,
    });
    expect(attempt.status).toBe(404);
    // La factura sigue ahí.
    expect(
      (await t.api(`/companies/${globex}/invoices`, { cookie: admin.cookie })).body.items,
    ).toHaveLength(1);
  });

  it('a business invoice needs a business that really belongs to the company in the path', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const globex = await company(t, admin.cookie, 'globex');
    const shop = await t.auth('/axeda/business/create', {
      method: 'POST',
      cookie: admin.cookie,
      body: { companyId: acme, slug: 'shop', name: 'Shop' },
    });
    expect(shop.status, JSON.stringify(shop.body)).toBe(200);
    const body = { customer: 'Walk-in', amount: 5 };
    const ok = await t.api(`/companies/${acme}/businesses/${shop.body.id}/invoices`, {
      method: 'POST',
      cookie: admin.cookie,
      origin: FRONTEND,
      body,
    });
    expect(ok.status).toBe(201);
    const wrong = await t.api(`/companies/${globex}/businesses/${shop.body.id}/invoices`, {
      method: 'POST',
      cookie: admin.cookie,
      origin: FRONTEND,
      body,
    });
    expect(wrong.status).toBe(403);
  });

  it('an invitation joins a new person to a company once she verifies her email', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const invited = await t.auth('/axeda/invitation/create', {
      method: 'POST',
      cookie: admin.cookie,
      body: {
        email: 'carla@example.com',
        scope: { type: 'company', id: acme },
        roleIds: [await roleId(t, admin.cookie, 'cashier')],
      },
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    const mail = t.outbox.findLast(
      (item) => item.to === 'carla@example.com' && item.link.startsWith(FRONTEND),
    );
    expect(mail).toBeDefined();
    const token = new URL(mail?.link ?? '').searchParams.get('token') ?? '';

    const carla = await t.register('carla');
    expect((await t.api(`/companies/${acme}/invoices`, { cookie: carla.cookie })).status).toBe(403);
    const accepted = await t.auth('/axeda/invitation/accept', {
      method: 'POST',
      cookie: carla.cookie,
      body: { token },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await t.api(`/companies/${acme}/invoices`, { cookie: carla.cookie })).status).toBe(200);
  });

  it('the menu shows each person only what she can use, in her language', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const ana = await t.register('ana');
    await assign(t, admin.cookie, ana.id, 'cashier', acme);
    const query = `?scopeType=company&scopeId=${acme}&locale=es`;
    const menu = await t.auth(`/axeda/menu${query}`, { cookie: ana.cookie });
    expect(menu.status).toBe(200);
    expect(menu.body.items).toHaveLength(1);
    expect(menu.body.items[0].label).toBe('Facturación');
    expect(menu.body.items[0].children[0].can).toEqual({
      'invoice:create': true,
      'invoice:delete': false,
    });
  });

  it('a banned person loses access at once', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const ana = await t.register('ana');
    await assign(t, admin.cookie, ana.id, 'cashier', acme);
    expect((await t.api(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(200);
    await t.auth('/axeda/user/ban', { method: 'POST', cookie: admin.cookie, body: { id: ana.id } });
    expect((await t.api(`/companies/${acme}/invoices`, { cookie: ana.cookie })).status).toBe(401);
    expect((await t.signIn(ana.email)).status).toBe(403);
  });
});

describe('the example’s own defences', () => {
  it('refuses a write that carries the cookie from an origin that is not the front end', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const evil = await t.api(`/companies/${acme}/invoices`, {
      method: 'POST',
      cookie: admin.cookie,
      origin: 'https://evil.example.net',
      body: { customer: 'x', amount: 1 },
    });
    expect(evil.status).toBe(403);
    expect(evil.body).toMatchObject({ code: 'AXEDA_CROSS_SITE' });
  });

  it('validates the body and never echoes internals', async () => {
    const t = await start();
    const admin = await administrator(t);
    const acme = await company(t, admin.cookie, 'acme');
    const post = (body: unknown) =>
      t.api(`/companies/${acme}/invoices`, {
        method: 'POST',
        cookie: admin.cookie,
        origin: FRONTEND,
        body,
      });
    for (const body of [
      {},
      { customer: '', amount: 1 },
      { customer: 'x', amount: -5 },
      { customer: 'x', amount: 1.5 },
      { customer: 'x', amount: 1, role: 'admin' },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    const malformed = await fetch(`${t.baseURL}/companies/${acme}/invoices`, {
      method: 'POST',
      headers: { cookie: admin.cookie, origin: FRONTEND, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toMatch(/at |node_modules|SyntaxError/);
  });

  it('does not announce the framework', async () => {
    const t = await start();
    const response = await fetch(`${t.baseURL}/health`);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('configuration fails at startup, not in production', () => {
  const base = { BASE_URL: 'https://api.example.com', BETTER_AUTH_SECRET: SECRET };

  it('reads and validates the environment', () => {
    expect(
      readConfig({ ...base, TRUSTED_ORIGINS: 'https://a.example.com, https://b.example.com' }),
    ).toMatchObject({
      environment: 'development',
      trustedOrigins: ['https://a.example.com', 'https://b.example.com'],
    });
    expect(readConfig(base).trustedOrigins).toEqual(['https://api.example.com']);
    expect(() => readConfig({ BASE_URL: 'https://x.example.com' })).toThrowError(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => readConfig({ BETTER_AUTH_SECRET: SECRET })).toThrowError(/BASE_URL/);
    expect(() => readConfig({ ...base, PORT: 'abc' })).toThrowError(/PORT/);
    expect(() => readConfig({ ...base, NODE_ENV: 'staging' })).toThrowError(/NODE_ENV/);
  });

  it('refuses to start in production with a weak secret or plain http', async () => {
    const production = (extra: Record<string, string>) =>
      createExample(
        readConfig({ NODE_ENV: 'production', DATABASE_FILE: ':memory:', ...base, ...extra }),
      );
    await expect(production({ BETTER_AUTH_SECRET: 'too-short' })).rejects.toMatchObject({
      code: 'AXEDA_INVALID_CONFIG',
    });
    await expect(production({ BASE_URL: 'http://api.example.com' })).rejects.toMatchObject({
      code: 'AXEDA_INVALID_CONFIG',
    });
  });
});
