import { createAuthClient } from 'better-auth/client';
import { describe, expect, it } from 'vitest';
import { axedaClient } from '../src/client.js';
import { createHttpApp, BASE_URL, type HttpApp } from './support/http.js';

/** Un cliente de Better Auth que habla con el servidor de prueba, con la cookie de un usuario. */
function clientFor(app: HttpApp, cookie: string) {
  return createAuthClient({
    baseURL: BASE_URL,
    plugins: [axedaClient()],
    fetchOptions: {
      customFetchImpl: (input, init) => {
        const request = new Request(input, init);
        request.headers.set('cookie', cookie);
        request.headers.set('origin', BASE_URL);
        return app.auth.handler(request);
      },
    },
  });
}

describe('the typed client', () => {
  it('calls the server end to end, with typed bodies and responses', async () => {
    const app = await createHttpApp();
    const admin = await app.signUp('admin');
    const alice = await app.signUp('alice');
    await app.plugin.instance().bootstrap({ userId: admin.id });
    const client = clientFor(app, admin.cookie);

    const created = await client.axeda.role.create({
      key: 'cashier',
      name: 'Cashier',
      permissions: ['invoice:read'],
    });
    expect(created.error).toBeNull();
    expect(created.data?.key).toBe('cashier');

    const assigned = await client.axeda.assignment.create({
      userId: alice.id,
      roleId: created.data?.id ?? '',
      scope: { type: 'global' },
    });
    expect(assigned.data?.grantedBy).toBe(admin.id);

    const me = await clientFor(app, alice.cookie).axeda.me();
    expect(me.data?.globalPermissions).toEqual(['invoice:read']);

    const list = await client.axeda.role.list({ query: { limit: 10 } });
    expect(list.data?.items.map((role) => role.key)).toContain('cashier');
  });

  it('returns the stable error code on failure', async () => {
    const app = await createHttpApp();
    const alice = await app.signUp('alice');
    const response = await clientFor(app, alice.cookie).axeda.role.create({
      key: 'nope',
      name: 'x',
      permissions: ['invoice:read'],
    });
    expect(response.data).toBeNull();
    expect(response.error?.status).toBe(403);
    expect(response.error?.code).toBe('AXEDA_FORBIDDEN');
  });
});

// --- Comprobaciones de tipos (las verifica `tsc`; si dejan de cumplirse, `npm run typecheck` falla)
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export async function typeChecks(app: HttpApp) {
  const client = clientFor(app, '');

  // El cuerpo está tipado: esto compila…
  await client.axeda.role.create({ key: 'a', name: 'A', permissions: [] });
  // …y esto debe fallar al compilar.
  // @ts-expect-error permissions debe ser string[]
  await client.axeda.role.create({ key: 'a', name: 'A', permissions: 'invoice:read' });
  // @ts-expect-error falta el cuerpo obligatorio
  await client.axeda.assignment.create({ userId: 'u' });
  await client.axeda.assignment.create({
    userId: 'u',
    roleId: 'r',
    // @ts-expect-error un tipo de alcance inexistente
    scope: { type: 'planet', id: 'b' },
  });
  // @ts-expect-error el endpoint no existe
  await client.axeda.nonexistent();

  // Usuarios y menú: también tipados de punta a punta.
  await client.axeda.user.create({ email: 'a@test.dev', name: 'A' });
  await client.axeda.user.ban({ id: 'u', reason: 'abuse', expiresAt: new Date().toISOString() });
  // @ts-expect-error Axeda no maneja contraseñas: el cuerpo no tiene ese campo
  await client.axeda.user.create({ email: 'a@test.dev', name: 'A', password: 'secret123' });
  // @ts-expect-error la fecha de fin viaja como texto ISO
  await client.axeda.user.ban({ id: 'u', expiresAt: new Date() });
  const menu = await client.axeda.menu({ query: { locale: 'es' } });
  const firstLabel: string | undefined = menu.data?.items[0]?.label;
  void firstLabel;

  const me = await client.axeda.me();
  const role = await client.axeda.role.get({ query: { id: 'x' } });
  type Me = NonNullable<typeof me.data>;
  type RoleData = NonNullable<typeof role.data>;
  return {
    me,
    role,
    globalPermissions: null as unknown as Expect<Equal<Me['globalPermissions'], string[]>>,
    status: null as unknown as Expect<Equal<RoleData['status'], 'active' | 'inactive'>>,
  };
}
