import type { SecondaryStorage } from '@better-auth/core/db';
import { describe, expect, it } from 'vitest';
import { sessionPrincipal } from '../src/index.js';
import { createHttpApp } from './support/http.js';

/** Un `secondaryStorage` en memoria, como lo usaría Redis. */
function memoryStorage(): SecondaryStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    getAndDelete: (key) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    increment: (key) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    },
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
  };
}

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

/**
 * Con `secondaryStorage`, Better Auth guarda junto a la sesión una copia de la fila del usuario y
 * solo la refresca cuando él mismo cambia al usuario. Axeda sube `authzVersion` por su cuenta, así
 * que esa copia queda vieja: si se usara, la caché seguiría concediendo lo revocado.
 */
async function world() {
  const app = await createHttpApp({ betterAuth: { secondaryStorage: memoryStorage() } });
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  const role = ok(
    await app.post(
      '/axeda/role/create',
      { key: 'reader', name: 'Reader', permissions: ['invoice:read'] },
      admin.cookie,
    ),
  ) as { id: string };
  const alice = await app.signUp('alice');
  const assignment = ok(
    await app.post(
      '/axeda/assignment/create',
      { userId: alice.id, roleId: role.id, scope: { type: 'global' } },
      admin.cookie,
    ),
  ) as { id: string };
  const revoke = async () =>
    ok(await app.post('/axeda/assignment/revoke', { id: assignment.id }, admin.cookie));
  return { app, alice, revoke };
}

describe('sessions kept in secondaryStorage', () => {
  it('a revoked permission stops counting on the plugin endpoints', async () => {
    const { app, alice, revoke } = await world();
    const before = ok(await app.get('/axeda/me', alice.cookie)) as { globalPermissions: string[] };
    expect(before.globalPermissions).toContain('invoice:read');

    await revoke();

    const after = ok(await app.get('/axeda/me', alice.cookie)) as { globalPermissions: string[] };
    expect(after.globalPermissions).not.toContain('invoice:read');
  });

  it('a revoked permission stops counting on the routes of the application', async () => {
    const { app, alice, revoke } = await world();
    const headers = new Headers({ cookie: alice.cookie });
    const core = app.plugin.instance();
    const principal = async () => {
      const found = await sessionPrincipal(app.auth)({ headers });
      if (found === null) throw new Error('expected a session');
      return found;
    };

    expect(await core.can(await principal(), 'invoice:read')).toBe(true);

    await revoke();

    expect(await core.can(await principal(), 'invoice:read')).toBe(false);
  });
});
