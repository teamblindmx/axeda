import { describe, expect, it } from 'vitest';
import { createBetterAuthPinHasher } from '../src/pin-hasher.js';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

describe('the PIN hasher on Better Auth', () => {
  it('uses Better Auth password hashing with a pepper from its secret', async () => {
    const app = await createHttpApp();
    const context = await app.auth.$context;
    const hasher = createBetterAuthPinHasher(context);
    const hash = await hasher.hash('381946');
    expect(hash).not.toContain('381946');
    expect(await hasher.verify('381946', hash)).toBe(true);
    expect(await hasher.verify('381947', hash)).toBe(false);
    // Sin la clave del servidor el hash no sirve: el mismo PIN con otro secreto no coincide.
    const other = createBetterAuthPinHasher({ ...context, secret: `${context.secret}-other` });
    expect(await other.verify('381946', hash)).toBe(false);
    // Ni es el hash de contraseña del PIN a secas.
    expect(await context.password.verify({ password: '381946', hash })).toBe(false);
    expect(await hasher.verify('381946', 'not-a-hash')).toBe(false);
  });
});

describe.each(databaseKinds)('staff accounts on a real Better Auth (%s)', (kind) => {
  async function world() {
    const app = await createHttpApp({ kind });
    const owner = await app.signUp('owner');
    const axeda = app.plugin.instance();
    await axeda.bootstrap({ userId: owner.id });
    const acme = await axeda.companies.create({ userId: owner.id }, { slug: 'acme', name: 'ACME' });
    return { app, axeda, owner: { userId: owner.id }, acme };
  }

  it('creates a staff user in Better Auth and signs it in with the PIN', async () => {
    const { app, axeda, owner, acme } = await world();
    const { member, pin } = await axeda.staff.create(owner, {
      scope: { type: 'company', id: acme.id },
      username: 'mesero1',
      name: 'Mesero Uno',
    });
    const context = await app.auth.$context;
    const user = (await context.internalAdapter.findUserById(member.userId)) as {
      email: string;
      name: string;
    } | null;
    expect(user?.name).toBe('Mesero Uno');
    expect(user?.email).toMatch(/@staff\.invalid$/);
    // No tiene contraseña de Better Auth: el PIN no sirve para el inicio de sesión por correo.
    const accounts = await context.internalAdapter.findAccounts(member.userId);
    expect(accounts).toEqual([]);
    expect(await axeda.staff.signIn({ company: 'acme', username: 'mesero1', pin })).toEqual({
      userId: member.userId,
    });
  });

  it('removes the staff account when Better Auth deletes the user, and the user when it is removed', async () => {
    const { app, axeda, owner, acme } = await world();
    const scope = { type: 'company', id: acme.id } as const;
    const first = await axeda.staff.create(owner, { scope, username: 'uno', name: 'Uno' });
    const second = await axeda.staff.create(owner, { scope, username: 'dos', name: 'Dos' });
    const context = await app.auth.$context;
    await context.internalAdapter.deleteUser(first.member.userId);
    const persistence = app.plugin.persistence();
    expect(await persistence.staff.get(first.member.userId)).toBeNull();

    await axeda.staff.remove(owner, second.member.userId);
    expect(await context.internalAdapter.findUserById(second.member.userId)).toBeNull();
    expect(await persistence.staff.get(second.member.userId)).toBeNull();
  });
});
