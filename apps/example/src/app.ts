import type { Server } from 'node:http';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import Database from 'better-sqlite3';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { axeda, secureAuthOptions, sessionPrincipal } from '@teamblind/axeda-better-auth';
import type { Axeda } from '@teamblind/axeda-core';
import { createAxedaExpress } from '@teamblind/axeda-express';
import type { ExampleConfig } from './config.js';
import { invoiceRoutes } from './invoices.js';
import { createDevMailer, type Mailer } from './mailer.js';

/** Los permisos de TU aplicación. Axeda añade los suyos (`axeda:role:manage`, …). */
export const PERMISSIONS = ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'];

export interface ExampleApp {
  readonly app: Express;
  readonly axeda: Axeda;
  readonly mailer: Mailer;
  /** Busca a una persona por su correo (para el comando `bootstrap`). */
  findUserByEmail(email: string): Promise<{ id: string; emailVerified: boolean } | null>;
  close(): Promise<void>;
}

/**
 * La aplicación completa: Better Auth (identidad) + Axeda (autorización) + rutas propias
 * protegidas con `@teamblind/axeda-express`.
 */
export async function createExample(
  config: ExampleConfig,
  options: { readonly mailer?: Mailer } = {},
): Promise<ExampleApp> {
  const mailer = options.mailer ?? createDevMailer();
  const frontend = config.trustedOrigins[0] ?? config.baseURL;

  // 1. Qué permisos existen y qué funciones trae la aplicación de fábrica.
  const axedaPlugin = axeda({
    permissions: PERMISSIONS,
    roles: {
      viewer: { name: 'Viewer', permissions: ['invoice:read', 'report:read'] },
      cashier: { name: 'Cashier', permissions: ['invoice:read', 'invoice:create'] },
      manager: { name: 'Manager', permissions: ['invoice:*', 'report:read'] },
    },
    menus: [
      { key: 'billing', label: { en: 'Billing', es: 'Facturación' }, icon: 'receipt', order: 1 },
      {
        key: 'invoices',
        parent: 'billing',
        path: '/invoices',
        label: { en: 'Invoices', es: 'Facturas' },
        requires: 'invoice:read',
        actions: ['invoice:create', 'invoice:delete'],
      },
      {
        key: 'reports',
        path: '/reports',
        label: { en: 'Reports', es: 'Reportes' },
        requires: 'report:read',
        order: 2,
      },
    ],
    // Axeda genera el secreto de la invitación; tú decides cómo se envía.
    invitationDelivery: {
      acceptUrl: (token) => `${frontend}/accept-invitation?token=${encodeURIComponent(token)}`,
      send: ({ email, link }) => mailer.send({ to: email, subject: 'You have been invited', link }),
    },
    publicIdentity: true,
  });

  // 2. Better Auth con la configuración segura recomendada, más el plugin de Axeda.
  const sqlite = new Database(config.databaseFile);
  sqlite.pragma('foreign_keys = ON');
  const authOptions = {
    ...secureAuthOptions({
      baseURL: config.baseURL,
      secret: config.secret,
      trustedOrigins: config.trustedOrigins,
      environment: config.environment,
      ...(config.trustedProxies.length > 0 ? { trustedProxies: config.trustedProxies } : {}),
    }),
    database: sqlite,
    plugins: [axedaPlugin],
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
        mailer.send({ to: user.email, subject: 'Verify your email', link: url }),
    },
  };
  await (await getMigrations(authOptions)).runMigrations();
  const auth = betterAuth(authOptions);
  await auth.$context;
  await axedaPlugin.start();

  // 3. Express: protege tus rutas con los mismos permisos.
  const x = createAxedaExpress({
    axeda: axedaPlugin.instance(),
    principal: sessionPrincipal(auth),
    trustedOrigins: config.trustedOrigins,
  });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustedProxies.length > 0) app.set('trust proxy', [...config.trustedProxies]);
  app.use((_request, response, next) => {
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Better Auth recibe la petición ANTES de `express.json()`: lee el cuerpo por su cuenta.
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_request, response) => void response.json({ ok: true }));
  app.use(invoiceRoutes(x));

  app.use((_request, response) => {
    response.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' });
  });
  const onError: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    // El detalle va al registro del servidor, nunca a la respuesta.
    console.error(`[error] ${request.method} ${request.path}`, error);
    if (response.headersSent) return;
    const malformed = (error as { type?: string } | null)?.type === 'entity.parse.failed';
    response
      .status(malformed ? 400 : 500)
      .json(
        malformed
          ? { code: 'INVALID_INPUT', message: 'Malformed request body.' }
          : { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
      );
  };
  app.use(onError);

  return {
    app,
    axeda: axedaPlugin.instance(),
    mailer,
    async findUserByEmail(email) {
      const context = await auth.$context;
      const found = await context.internalAdapter.findUserByEmail(email);
      return found === null
        ? null
        : { id: found.user.id, emailVerified: found.user.emailVerified === true };
    },
    async close() {
      sqlite.close();
    },
  };
}

/** Pone la aplicación a escuchar. */
export function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}
