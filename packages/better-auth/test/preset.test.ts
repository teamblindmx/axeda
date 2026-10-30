import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { axeda, secureAuthOptions, type SecureAuthInput } from '../src/index.js';
import { closeAfterTest } from './support/cleanup.js';

const SECRET = 'k3Jx9Qp2Zr7Lm4Vb8Nc1Td6Wy5Hs0Ga3Fe9Uo2Ri7Pq';
const ISSUER = 'https://auth.example.com';
const APP = 'https://app.example.com';
const PASSWORD = 'correct-horse-battery-12';

const input = (extra: Partial<SecureAuthInput> = {}): SecureAuthInput => ({
  baseURL: ISSUER,
  secret: SECRET,
  trustedOrigins: [APP],
  ...extra,
});

function refused(extra: Partial<SecureAuthInput>, fragment: string) {
  try {
    secureAuthOptions(input(extra));
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(error).toMatchObject({ code: 'AXEDA_INVALID_CONFIG' });
    expect((error as Error).message).toContain(fragment);
  }
}

describe('secureAuthOptions: weak configurations are refused', () => {
  it('requires a long, non-repetitive secret', () => {
    refused({ secret: 'short' }, 'at least 32');
    refused({ secret: 'a'.repeat(40) }, 'too repetitive');
    refused({ secret: 'abababababababababababababababab' }, 'too repetitive');
  });

  it('requires https in production, but allows localhost in development', () => {
    refused({ baseURL: 'http://auth.example.com' }, 'must use https');
    refused({ trustedOrigins: ['http://app.example.com'] }, 'must use https');
    refused({ baseURL: 'http://localhost:3000' }, 'must use https');
    const dev = secureAuthOptions(
      input({
        environment: 'development',
        baseURL: 'http://localhost:3000',
        trustedOrigins: ['http://localhost:5173'],
        requireEmailVerification: false,
      }),
    );
    expect(dev.advanced.useSecureCookies).toBe(false);
    refused(
      { environment: 'development', trustedOrigins: ['http://app.example.com'] },
      'only for localhost',
    );
  });

  it('refuses wildcards, paths, credentials and an empty list of origins', () => {
    refused({ trustedOrigins: ['https://*.example.com'] }, 'wildcard');
    refused({ trustedOrigins: ['https://app.example.com/dashboard'] }, 'just an origin');
    refused({ trustedOrigins: ['https://user:pw@app.example.com'] }, 'just an origin');
    refused({ trustedOrigins: ['not a url'] }, 'not a valid URL');
    refused({ trustedOrigins: ['ftp://app.example.com'] }, 'http or https');
    refused({ trustedOrigins: [] }, 'at least one trusted origin');
    refused({ baseURL: 'nope' }, 'not a valid URL');
  });

  it('does not let production skip email verification', () => {
    refused({ requireEmailVerification: false }, 'only for development');
  });

  it('normalises origins and removes duplicates', () => {
    const options = secureAuthOptions(input({ trustedOrigins: [APP, `${APP}/`, APP] }));
    expect(options.trustedOrigins).toEqual([APP]);
  });

  it('keeps a base path in the baseURL', () => {
    expect(secureAuthOptions(input({ baseURL: `${ISSUER}/api/auth` })).baseURL).toBe(
      `${ISSUER}/api/auth`,
    );
  });

  it('only adds trusted proxies when asked', () => {
    expect(secureAuthOptions(input()).advanced.ipAddress).toBeUndefined();
    expect(secureAuthOptions(input({ trustedProxies: ['10.0.0.0/8'] })).advanced.ipAddress).toEqual(
      {
        trustedProxies: ['10.0.0.0/8'],
      },
    );
  });
});

/** Un Better Auth real con el preset, el plugin de Axeda y la verificación de correo. */
async function createApp(extra: Partial<SecureAuthInput> = {}) {
  const sqlite = new Database(':memory:');
  closeAfterTest(() => void sqlite.close());
  const mails: Array<{ to: string; url: string }> = [];
  const plugin = axeda({ permissions: ['invoice:read'] });
  const config = {
    ...secureAuthOptions(input(extra)),
    database: sqlite,
    plugins: [plugin],
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        mails.push({ to: user.email, url });
      },
    },
  };
  await (await getMigrations(config)).runMigrations();
  const auth = betterAuth(config);
  await auth.$context;
  await plugin.start();

  const send = (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) =>
    auth.handler(
      new Request(`${ISSUER}/api/auth${path}`, {
        method: init.method ?? 'POST',
        headers: {
          origin: APP,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  const signUp = (name: string, password = PASSWORD) =>
    send('/sign-up/email', {
      body: { email: `${name}@example.com`, name, password },
    });
  const signIn = (name: string, password = PASSWORD, headers: Record<string, string> = {}) =>
    send('/sign-in/email', { body: { email: `${name}@example.com`, password }, headers });
  return { auth, plugin, mails, send, signUp, signIn };
}

describe('secureAuthOptions on a real Better Auth', () => {
  it('rejects short passwords', async () => {
    const app = await createApp();
    const response = await app.signUp('ana', 'short-pw-1');
    expect(response.status).toBe(400);
  });

  it('requires a verified email, and the real verification flow works end to end', async () => {
    const app = await createApp();
    expect((await app.signUp('ana')).status).toBe(200);

    // Sin verificar no hay sesión.
    const early = await app.signIn('ana');
    expect(early.status).toBe(403);
    expect(early.headers.getSetCookie()).toEqual([]);

    // El correo de verificación llegó al callback de la aplicación; el enlace lo verifica.
    expect(app.mails.map((mail) => mail.to)).toContain('ana@example.com');
    const link = app.mails.at(-1)?.url ?? '';
    expect(link.startsWith(`${ISSUER}/api/auth/verify-email?token=`)).toBe(true);
    const verified = await app.auth.handler(new Request(link));
    expect([200, 302]).toContain(verified.status);

    const signedIn = await app.signIn('ana');
    expect(signedIn.status).toBe(200);
    const cookies = signedIn.headers.getSetCookie().join(' | ');
    expect(cookies).toMatch(/HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Lax/i);
    expect(cookies).toMatch(/Secure/i);
    expect(cookies).toMatch(/__Secure-/);
  });

  it('refuses a forged verification token', async () => {
    const app = await createApp();
    await app.signUp('ana');
    const forged = await app.auth.handler(
      new Request(`${ISSUER}/api/auth/verify-email?token=${'x'.repeat(40)}`),
    );
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect((await app.signIn('ana')).status).toBe(403);
  });

  it('refuses a cookie-bearing request from an origin that is not trusted', async () => {
    const app = await createApp();
    await app.signUp('ana');
    await app.auth.handler(new Request(app.mails.at(-1)?.url ?? ''));
    const cookie = (await app.signIn('ana')).headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie).not.toBe('');

    const evil = await app.send('/axeda/role/create', {
      body: { key: 'x', name: 'X', permissions: ['invoice:read'] },
      headers: { cookie, origin: 'https://evil.example.net' },
    });
    expect(evil.status).toBe(403);
  });

  it('limits sign-in attempts per address', async () => {
    const app = await createApp();
    await app.signUp('ana');
    // El contador en memoria de Better Auth es del proceso: cada prueba usa su propia dirección.
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      statuses.push((await app.signIn('ana', 'wrong-password-123', from('203.0.113.7'))).status);
    }
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    // Es por dirección: otra persona, desde otra IP, no queda bloqueada.
    expect((await app.signIn('ana', 'wrong-password-123', from('203.0.113.8'))).status).toBe(401);
  });
});
