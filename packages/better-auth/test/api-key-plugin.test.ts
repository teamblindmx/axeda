import { apiKey } from '@better-auth/api-key';
import { twoFactor } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import { sessionPrincipal } from '../src/index.js';
import { createHttpApp, PASSWORD } from './support/http.js';
import { memoryStorage } from './support/memory-storage.js';
import { turnOnTwoFactor } from './support/second-factor.js';

/**
 * Las llaves de API con el plugin `apiKey` de Better Auth de verdad. Con `enableSessionForAPIKeys`,
 * una petición con la cabecera de la llave llega como una sesión de su dueño, también a `/axeda/*`.
 */

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

interface KeyApi {
  createApiKey(input: { body: { userId: string; name: string } }): Promise<{ key: string }>;
}

async function world(secondaryStorage: boolean) {
  const app = await createHttpApp({
    extraPlugins: [twoFactor({ issuer: 'axeda-tests' }), apiKey({ enableSessionForAPIKeys: true })],
    ...(secondaryStorage ? { betterAuth: { secondaryStorage: memoryStorage() } } : {}),
  });
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  const role = async (key: string, requireMfa: boolean) =>
    ok(
      await app.post(
        '/axeda/role/create',
        { key, name: key, permissions: ['invoice:read'], requireMfa },
        admin.cookie,
      ),
    ) as { id: string };
  const assign = async (userId: string, roleId: string) =>
    ok(
      await app.post(
        '/axeda/assignment/create',
        { userId, roleId, scope: { type: 'global' } },
        admin.cookie,
      ),
    ) as { id: string };
  const alice = await app.signUp('alice');
  const keyFor = async (userId: string) =>
    (await (app.auth.api as unknown as KeyApi).createApiKey({ body: { userId, name: 'ci' } })).key;
  const withKey = (key: string, path = '/axeda/me') =>
    app.send(path, { headers: { 'x-api-key': key } });
  const permissionsOf = async (key: string): Promise<string[]> => {
    const me = ok(await withKey(key)) as { globalPermissions: string[] };
    return me.globalPermissions;
  };
  return { app, admin, alice, role, assign, keyFor, withKey, permissionsOf };
}

describe.each([
  ['sessions in the database', false],
  ['sessions in secondaryStorage', true],
])('API keys with the real plugin (%s)', (_label, secondaryStorage) => {
  it('a key holds what its owner holds, and no more', async () => {
    const { app, admin, alice, role, assign, keyFor, withKey, permissionsOf } =
      await world(secondaryStorage);
    await assign(alice.id, (await role('reader', false)).id);
    const aliceKey = await keyFor(alice.id);
    const adminKey = await keyFor(admin.id);

    expect(await permissionsOf(aliceKey)).toEqual(['invoice:read']);
    const body = { key: 'extra', name: 'Extra', permissions: ['invoice:read'] };
    const refused = await app.send('/axeda/role/create', {
      method: 'POST',
      headers: { 'x-api-key': aliceKey },
      body,
    });
    expect([refused.status, refused.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
    const allowed = await app.send('/axeda/role/create', {
      method: 'POST',
      headers: { 'x-api-key': adminKey },
      body,
    });
    expect(allowed.status).toBe(200);
    expect((await withKey('x'.repeat(64))).status).toBe(401);
  });

  it('revoking the assignment takes the permission away from the key at once', async () => {
    const { app, admin, alice, role, assign, keyFor, permissionsOf } =
      await world(secondaryStorage);
    const assignment = await assign(alice.id, (await role('reader', false)).id);
    const key = await keyFor(alice.id);
    expect(await permissionsOf(key)).toEqual(['invoice:read']);

    ok(await app.post('/axeda/assignment/revoke', { id: assignment.id }, admin.cookie));

    expect(await permissionsOf(key)).toEqual([]);
  });

  it('the key of a banned person holds no permission', async () => {
    const { app, admin, alice, role, assign, keyFor, permissionsOf } =
      await world(secondaryStorage);
    await assign(alice.id, (await role('reader', false)).id);
    const key = await keyFor(alice.id);
    expect(await permissionsOf(key)).toEqual(['invoice:read']);

    ok(await app.post('/axeda/user/ban', { id: alice.id }, admin.cookie));

    expect(await permissionsOf(key)).toEqual([]);
    const principal = await sessionPrincipal(app.auth)({
      headers: new Headers({ 'x-api-key': key }),
    });
    expect(principal).toMatchObject({ userId: alice.id, banned: true });
    expect(await app.plugin.instance().can(principal ?? { userId: alice.id }, 'invoice:read')).toBe(
      false,
    );
  });

  it('sessionPrincipal turns a key into the caller of a route of the application', async () => {
    const { app, alice, role, assign, keyFor } = await world(secondaryStorage);
    await assign(alice.id, (await role('reader', false)).id);
    const key = await keyFor(alice.id);
    const principalOf = sessionPrincipal(app.auth);

    const caller = await principalOf({ headers: new Headers({ 'x-api-key': key }) });
    expect(caller).toMatchObject({ userId: alice.id, banned: false });
    expect(await app.plugin.instance().can(caller ?? { userId: alice.id }, 'invoice:read')).toBe(
      true,
    );
    // Sin cookie ni llave no hay nadie; con una llave que no existe, la petición falla y no pasa.
    expect(await principalOf({ headers: new Headers() })).toBeNull();
    await expect(
      principalOf({ headers: new Headers({ 'x-api-key': 'x'.repeat(64) }) }),
    ).rejects.toBeDefined();
  });

  it('a key of someone with 2FA on carries the permissions of a role that requires 2FA', async () => {
    const { app, alice, role, assign, keyFor, permissionsOf } = await world(secondaryStorage);
    const finance = await role('finance', true);
    const phone = await turnOnTwoFactor(app, alice);
    await assign(alice.id, finance.id);
    const key = await keyFor(alice.id);

    // Límite conocido: a la llave nadie le pide un código. Hereda lo que tiene su dueño, y el
    // dueño tiene 2FA activado, así que arrastra lo que exige 2FA. Se usa con funciones estrechas.
    expect(await permissionsOf(key)).toEqual(['invoice:read']);

    ok(await app.post('/two-factor/disable', { password: PASSWORD }, phone.cookie));

    // Y en cuanto su dueño lo desactiva, la llave lo pierde.
    expect(await permissionsOf(key)).toEqual([]);
  });
});
