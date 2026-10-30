import { createMemoryPersistence, createMemoryUserDirectory } from '@teamblind/axeda-testing';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SCOPE,
  SUPER_ADMIN_ROLE_KEY,
  createAxeda,
  isAxedaError,
  type AxedaErrorCode,
  type AxedaOptions,
} from '../src/index.js';
import { BASE_OPTIONS, createFixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
};

function bare(options: AxedaOptions = BASE_OPTIONS) {
  const persistence = createMemoryPersistence();
  const users = createMemoryUserDirectory([{ id: 'first' }, { id: 'second' }]);
  const axeda = createAxeda(options, { persistence, users });
  return { persistence, users, axeda };
}

describe('bootstrap', () => {
  it('creates the first global administrator with the total permission', async () => {
    const { axeda, persistence } = bare();
    const result = await axeda.bootstrap({ userId: 'first', ip: '198.51.100.4' });

    const role = await persistence.roles.get(result.roleId);
    expect(role).toMatchObject({ key: SUPER_ADMIN_ROLE_KEY, managed: true, permissions: ['*'] });
    expect(await axeda.can({ userId: 'first' }, 'invoice:delete')).toBe(true);
    expect(await axeda.can({ userId: 'first' }, 'axeda:role:manage')).toBe(true);
    expect(await axeda.can({ userId: 'second' }, 'invoice:read')).toBe(false);

    const [event] = (
      await axeda.listAudit({ userId: 'first' }, { action: 'bootstrap' }, { limit: 5 })
    ).items;
    expect(event).toMatchObject({
      actorId: null,
      targetId: 'first',
      ip: '198.51.100.4',
      outcome: 'success',
    });
  });

  it('refuses to run twice', async () => {
    const { axeda } = bare();
    await axeda.bootstrap({ userId: 'first' });
    await rejectsWith(axeda.bootstrap({ userId: 'second' }), 'AXEDA_ALREADY_BOOTSTRAPPED');
    expect(await axeda.can({ userId: 'second' }, 'invoice:read')).toBe(false);
  });

  it('refuses an unknown user', async () => {
    const { axeda } = bare();
    await rejectsWith(axeda.bootstrap({ userId: 'ghost' }), 'AXEDA_USER_NOT_FOUND');
  });

  it('lets exactly one of several simultaneous calls win', async () => {
    const { axeda, persistence } = bare();
    const results = await Promise.allSettled([
      axeda.bootstrap({ userId: 'first' }),
      axeda.bootstrap({ userId: 'second' }),
      axeda.bootstrap({ userId: 'first' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const holders = await persistence.assignments.listForScope(GLOBAL_SCOPE, { limit: 10 });
    expect(holders.items).toHaveLength(1);
  });

  it('works again if the last administrator disappears (the recovery path)', async () => {
    const { axeda, persistence } = bare();
    const { assignmentId } = await axeda.bootstrap({ userId: 'first' });
    await persistence.assignments.revoke(assignmentId);
    await persistence.authz.bumpUserVersion('first');
    await axeda.bootstrap({ userId: 'second' });
    expect(await axeda.can({ userId: 'second' }, 'invoice:read')).toBe(true);
  });

  it('does not count an expired or deactivated administrator as one', async () => {
    const { axeda, persistence } = bare();
    const { roleId } = await axeda.bootstrap({ userId: 'first' });
    const role = await persistence.roles.get(roleId);
    await persistence.roles.update(roleId, role?.version ?? 0, { status: 'inactive' });
    await rejectsWith(axeda.bootstrap({ userId: 'second' }), 'AXEDA_INVALID_CONFIG');
  });

  it('is not exposed as an administrator action: a regular role cannot use it as a ladder', async () => {
    const f = await createFixture();
    await f.role('reader', ['invoice:read']);
    f.user('mallory');
    await f.give('mallory', 'reader');
    // bootstrap es del servidor; aun así no debe poder repetirse con un administrador presente.
    await rejectsWith(f.axeda.bootstrap({ userId: 'mallory' }), 'AXEDA_ALREADY_BOOTSTRAPPED');
    expect(await f.axeda.can({ userId: 'mallory' }, 'invoice:delete')).toBe(false);
  });
});

describe('roles declared in code (managed)', () => {
  const options: AxedaOptions = {
    permissions: ['invoice:read', 'invoice:create'],
    roles: {
      cashier: { name: 'Cashier', permissions: ['invoice:read', 'invoice:create'] },
      viewer: ['invoice:read'],
    },
  };

  it('are created at start as managed, active roles, and audited', async () => {
    const { axeda, persistence } = bare(options);
    await axeda.start();
    const cashier = await persistence.roles.getByKey('cashier');
    expect(cashier).toMatchObject({ managed: true, status: 'active', name: 'Cashier' });
    expect((await persistence.roles.getByKey('viewer'))?.permissions).toEqual(['invoice:read']);
    const events = await persistence.audit.list({ action: 'role.sync' }, { limit: 10 });
    expect(events.items).toHaveLength(2);
  });

  it('start is a no-op when nothing changed, even across restarts', async () => {
    const { persistence, users } = bare(options);
    await createAxeda(options, { persistence, users }).start();
    const versionAfterFirst = await persistence.authz.getPolicyVersion();
    await createAxeda(options, { persistence, users }).start();
    await createAxeda(options, { persistence, users }).start();
    expect(await persistence.authz.getPolicyVersion()).toBe(versionAfterFirst);
    expect(
      (await persistence.audit.list({ action: 'role.sync' }, { limit: 10 })).items,
    ).toHaveLength(2);
  });

  it('follows the code when a definition changes, and bumps the policy version', async () => {
    const { persistence, users } = bare(options);
    await createAxeda(options, { persistence, users }).start();
    const before = await persistence.authz.getPolicyVersion();

    const changed: AxedaOptions = {
      ...options,
      roles: { ...options.roles, viewer: ['invoice:read', 'invoice:create'] },
    };
    await createAxeda(changed, { persistence, users }).start();
    expect([...((await persistence.roles.getByKey('viewer'))?.permissions ?? [])].sort()).toEqual([
      'invoice:create',
      'invoice:read',
    ]);
    expect(await persistence.authz.getPolicyVersion()).toBeGreaterThan(before);
  });

  it('puts a managed role back if someone deactivated it behind the API', async () => {
    const { persistence, users } = bare(options);
    await createAxeda(options, { persistence, users }).start();
    const viewer = await persistence.roles.getByKey('viewer');
    await persistence.roles.update(viewer?.id ?? '', viewer?.version ?? 0, { status: 'inactive' });
    await createAxeda(options, { persistence, users }).start();
    expect((await persistence.roles.getByKey('viewer'))?.status).toBe('active');
  });

  it('deactivates, but does not delete, a managed role removed from the code (fail safe)', async () => {
    const { persistence, users } = bare(options);
    await createAxeda(options, { persistence, users }).start();
    const withoutViewer: AxedaOptions = {
      ...options,
      roles: { cashier: options.roles?.['cashier'] ?? [] },
    };
    await createAxeda(withoutViewer, { persistence, users }).start();
    expect(await persistence.roles.getByKey('viewer')).toMatchObject({
      status: 'inactive',
      managed: true,
    });
  });

  it('never deactivates the super-admin role created by bootstrap', async () => {
    const { axeda, persistence, users } = bare(options);
    await axeda.bootstrap({ userId: 'first' });
    await createAxeda(options, { persistence, users }).start();
    expect((await persistence.roles.getByKey(SUPER_ADMIN_ROLE_KEY))?.status).toBe('active');
  });

  it('refuses to start if a runtime role already uses a declared key', async () => {
    const { persistence, users } = bare(options);
    await persistence.roles.create({ key: 'viewer', name: 'hand made', permissions: [] });
    const axeda = createAxeda(options, { persistence, users });
    await rejectsWith(axeda.start(), 'AXEDA_INVALID_CONFIG');
    await rejectsWith(axeda.can({ userId: 'first' }, 'invoice:read'), 'AXEDA_INVALID_CONFIG');
  });

  it('survives several instances starting at the same time', async () => {
    const { persistence, users } = bare(options);
    await Promise.all(
      Array.from({ length: 5 }, () => createAxeda(options, { persistence, users }).start()),
    );
    const roles = await persistence.roles.list({ limit: 10 });
    expect(roles.items.map((r) => r.key).sort()).toEqual(['cashier', 'viewer']);
  });

  it('cannot be modified, deleted or reactivated through the API', async () => {
    const f = await createFixture(options);
    const cashier = await f.persistence.roles.getByKey('cashier');
    if (cashier === null) throw new Error('the managed role should exist');
    const { id, version } = cashier;
    await rejectsWith(
      f.axeda.roles.update(f.admin, id, version, { name: 'x' }),
      'AXEDA_ROLE_MANAGED',
    );
    await rejectsWith(
      f.axeda.roles.setStatus(f.admin, id, version, 'inactive'),
      'AXEDA_ROLE_MANAGED',
    );
    await rejectsWith(f.axeda.roles.delete(f.admin, id), 'AXEDA_ROLE_MANAGED');
  });
});
