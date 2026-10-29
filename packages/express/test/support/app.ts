import { createServer, type Server } from 'node:http';
import { createServer as createProbe, type AddressInfo } from 'node:net';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import Database from 'better-sqlite3';
import express, { type ErrorRequestHandler } from 'express';
import { sessionPrincipal, axeda } from '@axeda/better-auth';
import type { Actor, Axeda, AssignmentScope } from '@axeda/core';
import {
  createAxedaExpress,
  resolveScope,
  type AxedaExpress,
  type PrincipalResolver,
} from '../../src/index.js';

export const APP = 'https://app.example.com';
export const EVIL = 'https://evil.example.net';
const PASSWORD = 'correct-horse-battery-12';

const cleanups: Array<() => void | Promise<void>> = [];
/** Cierra servidores y bases de datos al terminar cada prueba. */
export async function closeAll(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

async function freePort(): Promise<number> {
  const probe = createProbe();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface TestApp {
  readonly origin: string;
  readonly core: Axeda;
  readonly x: AxedaExpress;
  readonly root: Actor;
  /** Veces que se preguntó por la sesión. */
  readonly sessionLookups: { count: number };
  signUp(name: string): Promise<{ id: string; cookie: string }>;
  call(
    path: string,
    init?: { method?: string; cookie?: string; origin?: string | null; body?: unknown },
  ): Promise<Reply>;
  /** Crea una función (como administrador) y la asigna. */
  give(userId: string, permissions: string[], scope: AssignmentScope): Promise<string>;
  company(slug: string): Promise<string>;
  business(slug: string, companyId: string): Promise<string>;
}

export interface AppOptions {
  /** Cambia cómo se resuelve quién llama (por defecto, la sesión de Better Auth). */
  readonly principal?: (real: PrincipalResolver) => PrincipalResolver;
  readonly csrf?: false;
}

/** Express 5 + Better Auth + el plugin de Axeda, de verdad, en un puerto libre. */
export async function startApp(options: AppOptions = {}): Promise<TestApp> {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const sqlite = new Database(':memory:');
  cleanups.push(() => void sqlite.close());

  const plugin = axeda({ permissions: ['invoice:read', 'invoice:create', 'report:read'] });
  const config = {
    secret: 'test-secret-test-secret-test-secret-0123456789',
    baseURL: origin,
    trustedOrigins: [APP],
    database: sqlite,
    emailAndPassword: { enabled: true },
    plugins: [plugin],
    rateLimit: { enabled: false },
  };
  await (await getMigrations(config)).runMigrations();
  const auth = betterAuth(config);
  await auth.$context;
  await plugin.start();
  const core = plugin.instance();

  const sessionLookups = { count: 0 };
  const real = sessionPrincipal(auth);
  const counted: PrincipalResolver = async (request) => {
    sessionLookups.count += 1;
    return real(request);
  };
  const principal = options.principal === undefined ? counted : options.principal(counted);
  const x = createAxedaExpress({
    axeda: core,
    principal,
    ...(options.csrf === false ? { csrf: false as const } : { trustedOrigins: [origin, APP] }),
  });

  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use(express.json());

  const inCompany = resolveScope({ company: 'companyId' });
  app.get('/public', (_request, response) => void response.json({ ok: true }));
  app.get('/me', x.requireAuth(), (request, response) => {
    const actor = x.principalOf(request);
    response.json({ userId: actor.userId, ip: actor.ip, userAgent: actor.userAgent });
  });
  app.post('/me', x.requireAuth(), (_request, response) => void response.json({ changed: true }));
  app.get(
    '/companies/:companyId/invoices',
    x.requirePermission('invoice:read', { scope: inCompany }),
    (request, response) => void response.json({ company: request.params['companyId'] }),
  );
  app.post(
    '/companies/:companyId/invoices',
    x.requirePermission('invoice:create', { scope: inCompany }),
    (_request, response) => void response.status(201).json({ created: true }),
  );
  app.get(
    '/companies/:companyId/businesses/:businessId/invoices',
    x.requirePermission('invoice:read', {
      scope: resolveScope({ company: 'companyId', business: 'businessId' }),
    }),
    (request, response) => void response.json({ business: request.params['businessId'] }),
  );
  app.get(
    '/businesses/:businessId/invoices',
    x.requirePermission('invoice:read', { scope: resolveScope({ business: 'businessId' }) }),
    (request, response) => void response.json({ business: request.params['businessId'] }),
  );
  app.get(
    '/chain/:companyId',
    x.requireAuth(),
    x.requirePermission('invoice:read', { scope: inCompany }),
    (_request, response) => void response.json({ ok: true }),
  );
  app.get(
    '/hidden/:companyId',
    x.requirePermission('invoice:read', { scope: inCompany, onDeny: 'not-found' }),
    (_request, response) => void response.json({ ok: true }),
  );
  app.get(
    '/invoices',
    x.requirePermission('invoice:read', {
      scope: resolveScope({ company: 'companyId', from: 'query' }),
    }),
    (_request, response) => void response.json({ ok: true }),
  );
  app.get(
    '/reports',
    x.requirePermission('report:read'),
    (_request, response) => void response.json({ ok: true }),
  );
  app.get('/mine', x.requireAuth(), async (request, response) => {
    response.json(await x.scopeFilter(request, 'invoice:read'));
  });
  const onError: ErrorRequestHandler = (_error, _request, response, _next) => {
    response.status(500).json({ code: 'INTERNAL' });
  };
  app.use(onError);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const rootUser = await auth.api.signUpEmail({
    body: { email: 'root@test.dev', password: PASSWORD, name: 'root' },
  });
  await core.bootstrap({ userId: rootUser.user.id });
  const root: Actor = { userId: rootUser.user.id, twoFactorEnabled: false };

  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${++counter}`;

  return {
    origin,
    core,
    x,
    root,
    sessionLookups,
    async signUp(name) {
      const response = await auth.api.signUpEmail({
        body: { email: `${name}@test.dev`, password: PASSWORD, name },
        asResponse: true,
      });
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const body = (await response.json()) as { user: { id: string } };
      return { id: body.user.id, cookie };
    },
    async call(path, init = {}) {
      const headers: Record<string, string> = {};
      if (init.cookie !== undefined) headers['cookie'] = init.cookie;
      if (init.origin !== null && init.origin !== undefined) headers['origin'] = init.origin;
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
    },
    async give(userId, permissions, scope) {
      const role = await core.roles.create(root, {
        key: unique('role'),
        name: 'Test role',
        permissions,
      });
      await core.assignments.assign(root, { userId, roleId: role.id, scope });
      return role.id;
    },
    async company(slug) {
      return (await core.companies.create(root, { slug, name: slug })).id;
    },
    async business(slug, companyId) {
      return (await core.businesses.create(root, companyId, { slug, name: slug })).id;
    },
  };
}
