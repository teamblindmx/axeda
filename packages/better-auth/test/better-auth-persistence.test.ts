import type { BetterAuthOptions } from '@better-auth/core';
import { GLOBAL_SCOPE, createAxeda, isAxedaError, parsePermissionKey } from '@axeda/core';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  MODELS,
  axeda,
  createBetterAuthPersistence,
  createBetterAuthUserDirectory,
} from '../src/index.js';
import { closeAfterTest } from './support/cleanup.js';
import { databaseKinds, openDatabase } from './support/databases.js';
import { createAuth, createUsers } from './support/harness.js';

const perms = (...keys: string[]) => keys.map(parsePermissionKey);

describe.each(databaseKinds)('Axeda on a real Better Auth (%s)', (kind) => {
  async function setup() {
    const ctx = await createAuth(kind);
    await createUsers(ctx.adapter, ['alice']);
    return { ...ctx, persistence: createBetterAuthPersistence(ctx.adapter) };
  }

  it('runs the whole authorization flow on top of it: bootstrap, grant, check, revoke', async () => {
    const { persistence, adapter } = await setup();
    await createUsers(adapter, ['bob']);
    const axedaCore = createAxeda(
      { permissions: ['invoice:read'] },
      { persistence, users: createBetterAuthUserDirectory(adapter) },
    );
    await axedaCore.start();

    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    await axedaCore.bootstrap({ userId: 'alice' });
    const role = await axedaCore.roles.create(alice, {
      key: 'reader',
      name: 'Reader',
      permissions: ['invoice:read'],
    });
    expect(await axedaCore.can(bob, 'invoice:read')).toBe(false);

    const assignment = await axedaCore.assignments.assign(alice, {
      userId: 'bob',
      roleId: role.id,
      scope: GLOBAL_SCOPE,
    });
    expect(await axedaCore.can(bob, 'invoice:read')).toBe(true);

    await axedaCore.roles.setStatus(alice, role.id, role.version, 'inactive');
    expect(await axedaCore.can(bob, 'invoice:read')).toBe(false);
    await axedaCore.roles.setStatus(alice, role.id, role.version + 1, 'active');
    expect(await axedaCore.can(bob, 'invoice:read')).toBe(true);

    await axedaCore.assignments.revoke(alice, assignment.id);
    expect(await axedaCore.can(bob, 'invoice:read')).toBe(false);

    const audit = await axedaCore.listAudit(alice, {}, { limit: 50 });
    expect(audit.items.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'bootstrap',
        'role.create',
        'assignment.create',
        'assignment.revoke',
      ]),
    );
  });

  it('reads users, their two-factor state and bans through the directory', async () => {
    const { adapter } = await setup();
    const directory = createBetterAuthUserDirectory(adapter);
    expect(await directory.find('alice')).toEqual({
      id: 'alice',
      email: 'alice@test.dev',
      emailVerified: false,
      twoFactorEnabled: false,
      banned: false,
    });
    expect((await directory.findByEmail('  ALICE@test.dev '))?.id).toBe('alice');
    expect(await directory.find('ghost')).toBeNull();
    expect(await directory.findByEmail('ghost@test.dev')).toBeNull();
  });

  it('removes the assignments of a user when Better Auth deletes the user', async () => {
    const { persistence, context } = await setup();
    const role = await persistence.roles.create({
      key: 'reader',
      name: 'Reader',
      permissions: perms('invoice:read'),
    });
    await persistence.assignments.create({ userId: 'alice', roleId: role.id, scope: GLOBAL_SCOPE });
    await context.internalAdapter.deleteUser('alice');
    expect(await persistence.assignments.listForUser('alice')).toEqual([]);
    expect(await persistence.roles.get(role.id)).not.toBeNull();
  });

  it('refuses to bump the version of a user that does not exist', async () => {
    const { persistence } = await setup();
    await expect(persistence.authz.bumpUserVersion('ghost')).rejects.toSatisfy((error) =>
      isAxedaError(error, 'AXEDA_USER_NOT_FOUND'),
    );
  });

  it('exposes the user version through the Better Auth session', async () => {
    const { auth, persistence } = await setup();
    const response = await auth.api.signUpEmail({
      body: { email: 'bob@test.dev', password: 'correct-horse-battery-12', name: 'Bob' },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const { user } = (await response.json()) as { user: { id: string } };
    const read = async () =>
      (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user as
        { authzVersion?: number } | undefined;

    expect((await read())?.authzVersion).toBe(0);
    await persistence.authz.bumpUserVersion(user.id);
    expect((await read())?.authzVersion).toBe(1);
  });

  it('survives a concurrent bump from two application instances (no lost increments)', async () => {
    const { adapter } = await setup();
    const first = createBetterAuthPersistence(adapter);
    const second = createBetterAuthPersistence(adapter);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first : second).authz.bumpPolicyVersion(),
      ),
    );
    expect(await first.authz.getPolicyVersion()).toBe(40);
    const rows = await adapter.findMany({ model: MODELS.state });
    expect(rows).toHaveLength(1);
  });

  it('round-trips every role field, including awkward text and a wide permission list', async () => {
    const { persistence } = await setup();
    const many = Array.from({ length: 100 }, (_, index) => `resource${index}:read`);
    const created = await persistence.roles.create({
      key: 'wide',
      name: `Ñandú "quoted" 日本語 — ${'x'.repeat(300)}`,
      description: "it's a 'description'; DROP TABLE axedaRole;--",
      permissions: perms(...many),
      requireMfa: true,
      managed: true,
    });
    const read = await persistence.roles.get(created.id);
    expect(read).toEqual(created);
    expect(read?.permissions).toHaveLength(100);
    expect(read?.name).toContain('Ñandú');
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it('keeps timestamps from the injected clock', async () => {
    const { adapter } = await setup();
    const at = new Date('2030-05-05T10:00:00.000Z');
    const persistence = createBetterAuthPersistence(adapter, { now: () => at });
    const role = await persistence.roles.create({
      key: 'timed',
      name: 'Timed',
      permissions: perms('a:b'),
    });
    expect(role.createdAt.getTime()).toBe(at.getTime());
    expect(role.updatedAt.getTime()).toBe(at.getTime());
  });

  it('treats an unknown role status as inactive (deny when in doubt)', async () => {
    const { persistence, adapter } = await setup();
    const role = await persistence.roles.create({
      key: 'odd',
      name: 'Odd',
      permissions: perms('a:b'),
    });
    await adapter.update({
      model: MODELS.role,
      where: [{ field: 'id', value: role.id }],
      update: { status: 'archived' },
    });
    expect((await persistence.roles.get(role.id))?.status).toBe('inactive');
  });

  it('fails loudly on an assignment with an unknown scope type instead of guessing', async () => {
    const { persistence, adapter } = await setup();
    const role = await persistence.roles.create({
      key: 'r',
      name: 'R',
      permissions: perms('a:b'),
    });
    await adapter.create({
      model: MODELS.assignment,
      data: {
        userId: 'alice',
        roleId: role.id,
        scopeType: 'planet',
        scopeId: 'mars',
        createdAt: new Date(),
      },
    });
    await expect(persistence.assignments.listForUser('alice')).rejects.toSatisfy((error) =>
      isAxedaError(error, 'AXEDA_DATA_CORRUPT'),
    );
  });

  it('fails loudly on a corrupted permission instead of deciding with it', async () => {
    const { persistence, adapter } = await setup();
    const role = await persistence.roles.create({
      key: 'r',
      name: 'R',
      permissions: perms('a:b'),
    });
    await adapter.update({
      model: MODELS.role,
      where: [{ field: 'id', value: role.id }],
      update: { permissions: ['NOT A PERMISSION'] },
    });
    await expect(persistence.roles.get(role.id)).rejects.toBeInstanceOf(Error);
  });
});

describe('databases without foreign keys (e.g. MongoDB)', () => {
  it('still deletes the assignments of a deleted role, without relying on cascades', async () => {
    const { adapter, db } = await createSqliteWithoutForeignKeys();
    await createUsers(adapter, ['alice']);
    const persistence = createBetterAuthPersistence(adapter);
    const role = await persistence.roles.create({
      key: 'reader',
      name: 'Reader',
      permissions: perms('invoice:read'),
    });
    await persistence.assignments.create({ userId: 'alice', roleId: role.id, scope: GLOBAL_SCOPE });

    expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
    expect(await persistence.roles.delete(role.id)).toBe(true);
    expect(await persistence.assignments.listForUser('alice')).toEqual([]);
    expect(await adapter.count({ model: MODELS.assignment })).toBe(0);
  });
});

async function createSqliteWithoutForeignKeys() {
  const db = new Database(':memory:');
  closeAfterTest(() => void db.close());
  db.pragma('foreign_keys = OFF');
  const config: BetterAuthOptions = {
    secret: 'test-secret-test-secret-test-secret-0123456789',
    baseURL: 'http://localhost:3000',
    database: db,
    emailAndPassword: { enabled: true },
    plugins: [axeda({ permissions: [] })],
  };
  await (await getMigrations(config)).runMigrations();
  const context = await betterAuth(config).$context;
  return { adapter: context.adapter, db };
}

describe('migrations', () => {
  const secret = 'test-secret-test-secret-test-secret-0123456789';

  it('creates the Axeda tables, is idempotent and keeps foreign keys and the unique index', async () => {
    const db = new Database(':memory:');
    closeAfterTest(() => void db.close());
    const options = {
      secret,
      baseURL: 'http://localhost:3000',
      database: db,
      emailAndPassword: { enabled: true },
      plugins: [axeda({ permissions: [] })],
    };
    const first = await getMigrations(options);
    const ddl = await first.compileMigrations();
    expect(ddl).toContain('axedaRole');
    expect(ddl).toContain('axedaAssignment');
    expect(ddl).toContain('axedaState');
    await first.runMigrations();

    const second = await getMigrations(options);
    expect(second.toBeCreated).toHaveLength(0);
    expect(second.toBeAdded).toHaveLength(0);

    const foreignKeys = db.prepare('PRAGMA foreign_key_list(axedaAssignment)').all() as Array<{
      table: string;
      on_delete: string;
    }>;
    expect(foreignKeys.map((key) => [key.table, key.on_delete]).sort()).toEqual([
      ['axedaRole', 'CASCADE'],
      ['user', 'CASCADE'],
    ]);
    const indexes = db.prepare('PRAGMA index_list(axedaAssignment)').all() as Array<{
      unique: number;
    }>;
    expect(indexes.some((index) => index.unique === 1)).toBe(true);
  });

  it.each(databaseKinds)(
    'gives users that existed before the plugin an authzVersion of 0, not NULL (%s)',
    async (kind) => {
      const { database } = await openDatabase(kind);
      const base = {
        secret,
        baseURL: 'http://localhost:3000',
        database,
        emailAndPassword: { enabled: true },
      };

      // 1) Una aplicación que todavía no usa Axeda, con un usuario.
      await (await getMigrations({ ...base, plugins: [] })).runMigrations();
      const before = betterAuth({ ...base, plugins: [] });
      await before.api.signUpEmail({
        body: { email: 'old@test.dev', password: 'correct-horse-battery-12', name: 'Old' },
      });

      // 2) La misma base con el plugin añadido.
      const withPlugin = { ...base, plugins: [axeda({ permissions: [] })] };
      await (await getMigrations(withPlugin)).runMigrations();
      const context = await betterAuth(withPlugin).$context;
      const persistence = createBetterAuthPersistence(context.adapter);
      const user = await context.adapter.findOne<{ id: string }>({
        model: 'user',
        where: [{ field: 'email', value: 'old@test.dev' }],
      });
      expect(user).not.toBeNull();
      const id = user?.id ?? '';

      expect(await persistence.authz.getUserVersion(id)).toBe(0);
      expect(await persistence.authz.bumpUserVersion(id)).toBe(1);
    },
  );
});
