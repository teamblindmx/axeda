import type { BetterAuthOptions } from '@better-auth/core';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import type Database from 'better-sqlite3';
import { axeda, type AxedaPlugin, type AxedaPluginOptions } from '../../src/index.js';
import { openDatabase, type DatabaseKind } from './databases.js';

export const BASE_URL = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery-12';

export const APP_PERMISSIONS = ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'];

export const APP_MENUS = [
  { key: 'billing', label: { es: 'Facturación', en: 'Billing' }, icon: 'receipt', order: 1 },
  {
    key: 'invoices',
    parent: 'billing',
    path: '/facturas',
    label: { es: 'Facturas', en: 'Invoices' },
    requires: 'invoice:read',
    actions: ['invoice:create', 'invoice:delete'],
  },
  { key: 'reports', path: '/reportes', label: 'Reports', requires: 'report:read', order: 2 },
];

export interface HttpResult {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly json: any;
}

export interface SentInvitation {
  readonly email: string;
  readonly token: string;
  readonly link: string;
}

export interface HttpApp {
  /** Invitaciones "enviadas" por el plugin. */
  readonly sent: SentInvitation[];
  readonly auth: ReturnType<typeof betterAuth>;
  readonly plugin: AxedaPlugin;
  readonly sqlite: Database.Database | undefined;
  /** Registra un usuario y devuelve su id y la cookie de sesión. */
  signUp(name: string): Promise<{ id: string; cookie: string }>;
  get(path: string, cookie?: string, query?: Record<string, string>): Promise<HttpResult>;
  post(path: string, body: unknown, cookie?: string): Promise<HttpResult>;
}

export interface HttpAppOptions {
  readonly kind?: DatabaseKind;
  readonly plugin?: Partial<AxedaPluginOptions>;
  readonly foreignKeys?: boolean;
  /** Sin envío de invitaciones configurado. */
  readonly withoutInvitations?: boolean;
  readonly betterAuth?: Partial<BetterAuthOptions>;
}

/** Un Better Auth real, migrado, con el plugin de Axeda y una API HTTP para llamarlo. */
export async function createHttpApp(options: HttpAppOptions = {}): Promise<HttpApp> {
  const { database, sqlite } = await openDatabase(options.kind ?? 'sqlite', {
    foreignKeys: options.foreignKeys !== false,
  });

  const sent: SentInvitation[] = [];
  const plugin = axeda({
    permissions: APP_PERMISSIONS,
    menus: APP_MENUS,
    publicIdentity: true,
    ...(options.withoutInvitations === true
      ? {}
      : {
          invitationDelivery: {
            acceptUrl: (token: string) =>
              `https://app.example/accept?token=${encodeURIComponent(token)}`,
            send: async (message: SentInvitation) => void sent.push(message),
          },
        }),
    ...options.plugin,
  });
  const config: BetterAuthOptions = {
    secret: 'test-secret-test-secret-test-secret-0123456789',
    baseURL: BASE_URL,
    database,
    emailAndPassword: { enabled: true },
    plugins: [plugin],
    rateLimit: { enabled: false },
    ...options.betterAuth,
  };
  await (await getMigrations(config)).runMigrations();
  const auth = betterAuth(config);
  await auth.$context;
  await plugin.start();

  const call = async (request: Request): Promise<HttpResult> => {
    const response = await auth.handler(request);
    const text = await response.text();
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null };
  };

  return {
    auth,
    plugin,
    sent,
    sqlite,
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
    get(path, cookie, query = {}) {
      const url = new URL(`${BASE_URL}/api/auth${path}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      return call(new Request(url, { headers: cookie === undefined ? {} : { cookie } }));
    },
    post(path, body, cookie) {
      return call(
        new Request(`${BASE_URL}/api/auth${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: BASE_URL,
            ...(cookie === undefined ? {} : { cookie }),
          },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}
