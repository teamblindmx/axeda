import { createMemoryPersistence, createMemoryUserDirectory } from '@teamblind/axeda-testing';
import { describe, expect, it, vi } from 'vitest';
import {
  AXEDA_PERMISSIONS,
  GLOBAL_SCOPE,
  createAxeda,
  isAxedaError,
  parsePermissionKey,
  type AxedaPersistence,
  type Clock,
  type TargetScope,
} from '../src/index.js';

const OPTIONS = {
  permissions: ['invoice:create', 'invoice:read', 'invoice:delete'],
} as const;
const alice = { userId: 'alice' };
const perms = (...raw: string[]) => raw.map(parsePermissionKey);

let users = createMemoryUserDirectory();
const ids: string[] = [];

/** Crea la compañía A y su negocio A1 con esos identificadores. */
async function seedTenants(persistence: AxedaPersistence): Promise<void> {
  ids.push('A', 'A1');
  const company = await persistence.companies.create({ slug: 'a', name: 'A' });
  await persistence.businesses.create({ companyId: company.id, slug: 'a1', name: 'A1' });
}

function setup() {
  users = createMemoryUserDirectory();
  const persistence = createMemoryPersistence({
    nextId: () => ids.shift() ?? globalThis.crypto.randomUUID(),
  });
  const clock = { current: new Date('2026-06-01T12:00:00.000Z') };
  const fakeClock: Clock = { now: () => clock.current };
  const axeda = createAxeda(OPTIONS, { persistence, clock: fakeClock, users });
  return { persistence, axeda, clock };
}

const businessA1: TargetScope = { type: 'business', companyId: 'A', businessId: 'A1' };

describe('startup checks', () => {
  it('starts on a persistence with real transactions, and only probes once', async () => {
    const persistence = createMemoryPersistence();
    const transaction = vi.spyOn(persistence, 'transaction');
    const axeda = createAxeda(OPTIONS, { persistence, users });
    await Promise.all([axeda.start(), axeda.start()]);
    await axeda.start();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when transactions do not roll back', async () => {
    const real = createMemoryPersistence();
    const fake: AxedaPersistence = { ...real, transaction: (callback) => callback(real) };
    const axeda = createAxeda(OPTIONS, { persistence: fake, users });
    await expect(axeda.start()).rejects.toMatchObject({ code: 'AXEDA_TRANSACTIONS_UNSUPPORTED' });
  });

  it('never serves a decision on an unverified persistence, even after the failure', async () => {
    const real = createMemoryPersistence();
    const fake: AxedaPersistence = { ...real, transaction: (callback) => callback(real) };
    const axeda = createAxeda(OPTIONS, { persistence: fake, users });
    await expect(axeda.start()).rejects.toBeInstanceOf(Error);
    await expect(axeda.can(alice, 'invoice:read')).rejects.toMatchObject({
      code: 'AXEDA_TRANSACTIONS_UNSUPPORTED',
    });
    await expect(axeda.effectivePermissions(alice)).rejects.toBeInstanceOf(Error);
  });

  it('does not retry a configuration failure: repeating it would not fix it', async () => {
    const real = createMemoryPersistence();
    let probes = 0;
    const fake: AxedaPersistence = {
      ...real,
      transaction: (callback) => {
        probes += 1;
        return callback(real);
      },
    };
    const axeda = createAxeda(OPTIONS, { persistence: fake, users });
    await expect(axeda.start()).rejects.toMatchObject({ code: 'AXEDA_TRANSACTIONS_UNSUPPORTED' });
    const probesAfterFirst = probes;

    await expect(axeda.start()).rejects.toMatchObject({ code: 'AXEDA_TRANSACTIONS_UNSUPPORTED' });
    await expect(axeda.can(alice, 'invoice:read')).rejects.toMatchObject({
      code: 'AXEDA_TRANSACTIONS_UNSUPPORTED',
    });
    expect(probes).toBe(probesAfterFirst);
  });

  it('cleans up the probe it leaves behind on a broken persistence', async () => {
    const real = createMemoryPersistence();
    const fake: AxedaPersistence = { ...real, transaction: (callback) => callback(real) };
    await createAxeda(OPTIONS, { persistence: fake, users })
      .start()
      .catch(() => undefined);
    expect((await real.roles.list({ limit: 10 })).items).toEqual([]);
  });

  it('reports the real cause when the startup probe fails for another reason (e.g. database down)', async () => {
    const real = createMemoryPersistence();
    const outage = new Error('connection refused');
    const down: AxedaPersistence = {
      ...real,
      transaction: () => Promise.reject(outage),
    };
    const axeda = createAxeda(OPTIONS, { persistence: down, users });
    await expect(axeda.start()).rejects.toBe(outage);
    await expect(axeda.can(alice, 'invoice:read')).rejects.toBe(outage);
  });

  it('retries the startup after a passing failure instead of staying broken', async () => {
    const real = createMemoryPersistence();
    let reachable = false;
    const flaky: AxedaPersistence = {
      ...real,
      transaction: (callback) =>
        reachable ? real.transaction(callback) : Promise.reject(new Error('connection refused')),
    };
    const axeda = createAxeda(OPTIONS, { persistence: flaky, users });
    await expect(axeda.start()).rejects.toThrow('connection refused');

    reachable = true;
    await axeda.start();
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('does not mistake another instance changing the policy for missing transactions', async () => {
    const real = createMemoryPersistence();
    // Mientras corre la prueba de arranque, otra instancia sincroniza sus funciones y confirma.
    const busy: AxedaPersistence = {
      ...real,
      transaction: async (callback) => {
        try {
          return await real.transaction(callback);
        } finally {
          await real.authz.bumpPolicyVersion();
        }
      },
    };
    await createAxeda(OPTIONS, { persistence: busy, users }).start();
  });

  it('uses the system clock when none is injected', async () => {
    const persistence = createMemoryPersistence();
    const axeda = createAxeda(OPTIONS, { persistence, users });
    const role = await persistence.roles.create({
      key: 'r',
      name: 'R',
      permissions: perms('invoice:read'),
    });
    await persistence.assignments.create({
      userId: 'alice',
      roleId: role.id,
      scope: GLOBAL_SCOPE,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
    await persistence.assignments.create({
      userId: 'bob',
      roleId: role.id,
      scope: GLOBAL_SCOPE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await axeda.can({ userId: 'bob' }, 'invoice:read')).toBe(true);
  });

  it('does not leave anything behind on a good persistence', async () => {
    const { persistence, axeda } = setup();
    await axeda.start();
    expect((await persistence.roles.list({ limit: 10 })).items).toEqual([]);
    expect(await persistence.authz.getPolicyVersion()).toBe(0);
  });

  it('rejects invalid options immediately', () => {
    expect(() =>
      createAxeda({ permissions: ['nope'] }, { persistence: createMemoryPersistence(), users }),
    ).toThrow(expect.objectContaining({ code: 'AXEDA_INVALID_CONFIG' }));
  });

  it('exposes the catalog with the Axeda permissions included', () => {
    const { axeda } = setup();
    expect(axeda.catalog).toContain(AXEDA_PERMISSIONS.roleManage);
    expect(axeda.catalog).toContain(parsePermissionKey('invoice:read'));
  });
});

describe('can()', () => {
  it('denies by default', async () => {
    const { axeda } = setup();
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('allows what the assigned role grants and denies the rest', async () => {
    const { persistence, axeda } = setup();
    const role = await persistence.roles.create({
      key: 'cashier',
      name: 'Cashier',
      permissions: perms('invoice:create', 'invoice:read'),
    });
    await persistence.assignments.create({ userId: 'alice', roleId: role.id, scope: GLOBAL_SCOPE });
    expect(await axeda.can(alice, 'invoice:create')).toBe(true);
    expect(await axeda.can(alice, 'invoice:read')).toBe(true);
    expect(await axeda.can(alice, 'invoice:delete')).toBe(false);
    expect(await axeda.can({ userId: 'bob' }, 'invoice:read')).toBe(false);
  });

  it('checks the global scope by default', async () => {
    const { persistence, axeda } = setup();
    await seedTenants(persistence);
    const role = await persistence.roles.create({
      key: 'r',
      name: 'R',
      permissions: perms('invoice:read'),
    });
    await persistence.assignments.create({
      userId: 'alice',
      roleId: role.id,
      scope: { type: 'company', id: 'A' },
    });
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
    expect(await axeda.can(alice, 'invoice:read', businessA1)).toBe(true);
  });

  it('inherits downwards and never sideways', async () => {
    const { persistence, axeda } = setup();
    await seedTenants(persistence);
    const role = await persistence.roles.create({
      key: 'r',
      name: 'R',
      permissions: perms('invoice:read'),
    });
    await persistence.assignments.create({
      userId: 'alice',
      roleId: role.id,
      scope: { type: 'company', id: 'A' },
    });
    expect(await axeda.can(alice, 'invoice:read', { type: 'company', companyId: 'A' })).toBe(true);
    expect(await axeda.can(alice, 'invoice:read', businessA1)).toBe(true);
    expect(await axeda.can(alice, 'invoice:read', { type: 'company', companyId: 'B' })).toBe(false);
    expect(
      await axeda.can(alice, 'invoice:read', {
        type: 'business',
        companyId: 'B',
        businessId: 'B1',
      }),
    ).toBe(false);
  });

  it('honours wildcards, including the Axeda permissions', async () => {
    const { persistence, axeda } = setup();
    const role = await persistence.roles.create({
      key: 'root',
      name: 'Root',
      permissions: perms('*'),
    });
    await persistence.assignments.create({ userId: 'alice', roleId: role.id, scope: GLOBAL_SCOPE });
    expect(await axeda.can(alice, 'invoice:delete')).toBe(true);
    expect(await axeda.can(alice, 'axeda:role:manage')).toBe(true);
  });

  it('honours assignment expiry using the injected clock', async () => {
    const { persistence, axeda, clock } = setup();
    const role = await persistence.roles.create({
      key: 'r',
      name: 'R',
      permissions: perms('invoice:read'),
    });
    await persistence.assignments.create({
      userId: 'alice',
      roleId: role.id,
      scope: GLOBAL_SCOPE,
      expiresAt: new Date('2026-06-01T13:00:00.000Z'),
    });
    expect(await axeda.can(alice, 'invoice:read')).toBe(true);
    clock.current = new Date('2026-06-01T13:00:00.000Z');
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('treats a typo in the permission as an error, not as a silent "no"', async () => {
    const { axeda } = setup();
    await expect(axeda.can(alice, 'invoice:raed')).rejects.toMatchObject({
      code: 'AXEDA_UNKNOWN_PERMISSION',
    });
    await expect(axeda.can(alice, 'Invoice')).rejects.toMatchObject({
      code: 'AXEDA_INVALID_PERMISSION',
    });
  });

  it('refuses to check a wildcard', async () => {
    const { axeda } = setup();
    await expect(axeda.can(alice, 'invoice:*')).rejects.toMatchObject({
      code: 'AXEDA_INVALID_PERMISSION',
    });
    await expect(axeda.can(alice, '*')).rejects.toMatchObject({ code: 'AXEDA_INVALID_PERMISSION' });
  });

  it('rejects a principal without a user id', async () => {
    const { axeda } = setup();
    await expect(axeda.can({ userId: '' }, 'invoice:read')).rejects.toSatisfy((error) =>
      isAxedaError(error, 'AXEDA_INVALID_CONFIG'),
    );
    await expect(axeda.can(undefined as never, 'invoice:read')).rejects.toBeInstanceOf(Error);
  });
});

/**
 * Lección de aloux-iam: allí, desactivar una función ocultaba el menú pero la API seguía
 * autorizando sus permisos. Aquí, cada forma de revocar debe denegar en la SIGUIENTE petición,
 * aunque haya una caché de por medio. Se hace por los casos de uso, que son los que suben las
 * versiones que la invalidan.
 */
describe('revocation takes effect on the very next check', () => {
  const admin = { userId: 'admin' };

  async function granted() {
    const ctx = setup();
    users.add({ id: 'alice' });
    users.add({ id: 'admin' });
    await ctx.axeda.bootstrap({ userId: 'admin' });
    const role = await ctx.axeda.roles.create(admin, {
      key: 'cashier',
      name: 'Cashier',
      permissions: ['invoice:read', 'invoice:create'],
    });
    const assignment = await ctx.axeda.assignments.assign(admin, {
      userId: 'alice',
      roleId: role.id,
      scope: GLOBAL_SCOPE,
    });
    // Se consulta antes y después: la primera deja la entrada en la caché.
    expect(await ctx.axeda.can(alice, 'invoice:read')).toBe(true);
    expect(await ctx.axeda.can(alice, 'invoice:read')).toBe(true);
    return { ...ctx, role, assignment };
  }

  it('when the role is deactivated', async () => {
    const { axeda, role } = await granted();
    await axeda.roles.setStatus(admin, role.id, role.version, 'inactive');
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('when a permission is removed from the role', async () => {
    const { axeda, role } = await granted();
    await axeda.roles.update(admin, role.id, role.version, { permissions: ['invoice:create'] });
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
    expect(await axeda.can(alice, 'invoice:create')).toBe(true);
  });

  it('when the assignment is revoked', async () => {
    const { axeda, assignment } = await granted();
    await axeda.assignments.revoke(admin, assignment.id);
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('when the role is deleted', async () => {
    const { axeda, role } = await granted();
    await axeda.roles.delete(admin, role.id);
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('when the user is deleted (what the Better Auth hook does)', async () => {
    const { axeda, persistence } = await granted();
    await persistence.assignments.deleteForUser('alice');
    await persistence.authz.bumpUserVersion('alice');
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('and reactivating the role restores access', async () => {
    const { axeda, role } = await granted();
    const off = await axeda.roles.setStatus(admin, role.id, role.version, 'inactive');
    expect(await axeda.can(alice, 'invoice:read')).toBe(false);
    await axeda.roles.setStatus(admin, off.id, off.version, 'active');
    expect(await axeda.can(alice, 'invoice:read')).toBe(true);
  });
});
