import { twoFactor } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import { sessionPrincipal } from '../src/index.js';
import { createHttpApp, PASSWORD } from './support/http.js';
import { memoryStorage } from './support/memory-storage.js';
import { signInWithSecondFactor, turnOnTwoFactor } from './support/second-factor.js';

/**
 * `requireMfa` contra el plugin `twoFactor` de Better Auth de verdad, no contra una marca fingida:
 * Axeda lee `twoFactorEnabled` de la fila del usuario, y es ese plugin quien la cambia.
 */

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

interface WorldOptions {
  /** Las sesiones viven en un almacén secundario (p. ej. Redis) en lugar de la base de datos. */
  readonly secondaryStorage?: boolean;
  readonly twoFactor?: Parameters<typeof twoFactor>[0];
}

/** Un administrador, una función `finance` que exige 2FA y a Alice, sin ninguna función aún. */
async function world(options: WorldOptions = {}) {
  const app = await createHttpApp({
    extraPlugins: [twoFactor({ issuer: 'axeda-tests', ...options.twoFactor })],
    ...(options.secondaryStorage === true
      ? { betterAuth: { secondaryStorage: memoryStorage() } }
      : {}),
  });
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  const role = ok(
    await app.post(
      '/axeda/role/create',
      { key: 'finance', name: 'Finance', permissions: ['invoice:read'], requireMfa: true },
      admin.cookie,
    ),
  ) as { id: string };
  const alice = await app.signUp('alice');
  const assign = (userId: string) =>
    app.post(
      '/axeda/assignment/create',
      { userId, roleId: role.id, scope: { type: 'global' } },
      admin.cookie,
    );
  /** Los permisos globales que Axeda reconoce a quien llega con estas cookies. */
  const permissions = async (cookie: string): Promise<string[]> => {
    const me = ok(await app.get('/axeda/me', cookie)) as { globalPermissions: string[] };
    return me.globalPermissions;
  };
  return { app, alice, email: 'alice@test.dev', assign, permissions };
}

describe.each([
  ['sessions in the database', false],
  ['sessions in secondaryStorage', true],
])('2FA with the real plugin (%s)', (_label, secondaryStorage) => {
  it('a role that requires 2FA is not given to someone who has not turned 2FA on', async () => {
    const { app, alice, assign } = await world({ secondaryStorage });
    const refused = await assign(alice.id);
    expect([refused.status, refused.json.code]).toEqual([403, 'AXEDA_MFA_REQUIRED']);

    await turnOnTwoFactor(app, alice);

    ok(await assign(alice.id));
  });

  it('a sign-in is not a session until the second factor is given', async () => {
    const { app, alice, email, assign, permissions } = await world({ secondaryStorage });
    const { secret } = await turnOnTwoFactor(app, alice);
    ok(await assign(alice.id));

    const first = await app.post('/sign-in/email', { email, password: PASSWORD });
    expect(first.json).toMatchObject({ twoFactorRedirect: true });
    // Con solo la contraseña no hay sesión: la cookie que se entrega es un desafío pendiente.
    expect((await app.get('/axeda/me', first.cookies)).status).toBe(401);

    const { cookie } = await signInWithSecondFactor(app, { email, secret });
    expect(await permissions(cookie)).toEqual(['invoice:read']);
  });

  it('turning 2FA off takes the permission away at once', async () => {
    const { app, alice, assign, permissions } = await world({ secondaryStorage });
    const { cookie } = await turnOnTwoFactor(app, alice);
    ok(await assign(alice.id));
    expect(await permissions(cookie)).toEqual(['invoice:read']);

    const off = ok(await app.post('/two-factor/disable', { password: PASSWORD }, cookie));
    expect(off).toMatchObject({ status: true });

    // Better Auth emite una sesión nueva al desactivarlo.
    const after = await app.post('/sign-in/email', { email: 'alice@test.dev', password: PASSWORD });
    expect(await permissions(after.cookies)).toEqual([]);
  });

  it('turning 2FA off on one device takes the permission away on the others', async () => {
    const { app, alice, email, assign, permissions } = await world({ secondaryStorage });
    const { cookie: phone, secret } = await turnOnTwoFactor(app, alice);
    ok(await assign(alice.id));
    const { cookie: laptop } = await signInWithSecondFactor(app, { email, secret });
    expect(await permissions(laptop)).toEqual(['invoice:read']);

    ok(await app.post('/two-factor/disable', { password: PASSWORD }, phone));

    // El portátil sigue con su sesión. Con un almacén secundario, Better Auth refresca por sí
    // mismo la copia del usuario de todas las sesiones cuando cambia el 2FA; esta prueba cuida que
    // nada de Axeda conserve un permiso que exige 2FA para quien ya no lo tiene.
    expect(await permissions(laptop)).toEqual([]);
    const principal = await sessionPrincipal(app.auth)({
      headers: new Headers({ cookie: laptop }),
    });
    expect(principal).toMatchObject({ userId: alice.id, twoFactorEnabled: false });
    expect(await app.plugin.instance().can(principal ?? { userId: alice.id }, 'invoice:read')).toBe(
      false,
    );
  });

  it('turning 2FA on on one device gives the permission to a device that signed in before', async () => {
    const { app, alice, email, assign, permissions } = await world({ secondaryStorage });
    const before = await app.post('/sign-in/email', { email, password: PASSWORD });
    expect(before.json.twoFactorRedirect).toBeUndefined();

    await turnOnTwoFactor(app, alice);
    ok(await assign(alice.id));

    expect(await permissions(before.cookies)).toEqual(['invoice:read']);
  });
});

describe('a trusted device', () => {
  /** Inicia sesión con 2FA y pide confiar en el dispositivo; vuelve a iniciar con esa cookie. */
  async function signInAgainFromTrustedDevice(options: WorldOptions) {
    const w = await world(options);
    const { secret } = await turnOnTwoFactor(w.app, w.alice);
    ok(await w.assign(w.alice.id));
    const { trustedDevice } = await signInWithSecondFactor(w.app, {
      email: w.email,
      secret,
      trustDevice: true,
    });
    const again = await w.app.post(
      '/sign-in/email',
      { email: w.email, password: PASSWORD },
      trustedDevice,
    );
    return { ...w, again };
  }

  it('skips the second factor by default, which is why the guide says to turn it off', async () => {
    const { again, permissions } = await signInAgainFromTrustedDevice({});
    // Solo con la contraseña, y Axeda da por cumplido el 2FA: la sesión no dice si se pidió.
    expect(again.json.twoFactorRedirect).toBeUndefined();
    expect(await permissions(again.cookies)).toEqual(['invoice:read']);
  });

  it('is turned off with trustDeviceMaxAge: 0, and the second factor is asked every time', async () => {
    const { again } = await signInAgainFromTrustedDevice({ twoFactor: { trustDeviceMaxAge: 0 } });
    expect(again.json).toMatchObject({ twoFactorRedirect: true });
  });
});
