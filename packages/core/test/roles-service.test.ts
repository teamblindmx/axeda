import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE, isAxedaError, type AxedaErrorCode } from '../src/index.js';
import { createFixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
};

describe('roles: creating', () => {
  it('lets a global administrator create a role and audits it', async () => {
    const { axeda, admin } = await createFixture();
    const role = await axeda.roles.create(admin, {
      key: 'cashier',
      name: 'Cashier',
      description: 'Front desk',
      permissions: ['invoice:read', 'invoice:create'],
    });
    expect(role).toMatchObject({ key: 'cashier', managed: false, status: 'active', version: 1 });

    const { items } = await axeda.listAudit(admin, { action: 'role.create' }, { limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actorId: 'admin',
      targetId: role.id,
      outcome: 'success',
      scope: GLOBAL_SCOPE,
    });
  });

  it('rejects an actor without axeda:role:manage, and audits the denial', async () => {
    const { axeda, admin, user } = await createFixture();
    const mallory = user('mallory');
    await rejectsWith(
      axeda.roles.create(mallory, { key: 'x', name: 'X', permissions: ['invoice:read'] }),
      'AXEDA_FORBIDDEN',
    );
    const denied = await axeda.listAudit(admin, { actorId: 'mallory' }, { limit: 10 });
    expect(denied.items).toHaveLength(1);
    expect(denied.items[0]).toMatchObject({
      action: 'role.create',
      outcome: 'denied',
      metadata: { reason: 'missing_role_permission' },
    });
    expect((await axeda.roles.list(admin, { limit: 10 })).items.map((r) => r.key)).not.toContain(
      'x',
    );
  });

  it('does not let a role manager create a role with permissions they do not hold', async () => {
    const f = await createFixture();
    await f.role('role-admin', ['axeda:role:manage', 'invoice:read']);
    const manager = f.user('manager');
    await f.give('manager', 'role-admin');

    await rejectsWith(
      f.axeda.roles.create(manager, { key: 'power', name: 'P', permissions: ['invoice:delete'] }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      f.axeda.roles.create(manager, { key: 'power', name: 'P', permissions: ['*'] }),
      'AXEDA_FORBIDDEN',
    );
    // Lo que sí tiene, puede ponerlo en una función.
    const ok = await f.axeda.roles.create(manager, {
      key: 'reader',
      name: 'R',
      permissions: ['invoice:read'],
    });
    expect(ok.key).toBe('reader');
  });

  it('does not reveal the permission catalog or role keys to someone who cannot manage roles', async () => {
    const f = await createFixture();
    await f.role('taken', ['invoice:read']);
    const outsider = f.user('outsider');
    for (const input of [
      { key: 'ok', name: 'x', permissions: ['secret:thing'] },
      { key: 'taken', name: 'x', permissions: ['invoice:read'] },
      { key: 'Bad Key', name: 'x', permissions: ['invoice:read'] },
      { key: 'super-admin', name: 'x', permissions: ['invoice:read'] },
    ]) {
      await rejectsWith(f.axeda.roles.create(outsider, input), 'AXEDA_FORBIDDEN');
    }
  });

  it('rejects invalid input with AXEDA_INVALID_INPUT', async () => {
    const { axeda, admin } = await createFixture();
    const bad = (input: unknown) => axeda.roles.create(admin, input as never);
    await rejectsWith(
      bad({ key: 'Bad Key', name: 'x', permissions: ['invoice:read'] }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ key: 'ok', name: '', permissions: ['invoice:read'] }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(bad({ key: 'ok', name: 'x', permissions: [] }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      bad({ key: 'ok', name: 'x', permissions: ['invoice:raed'] }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(bad({ key: 'ok', name: 'x', permissions: ['Nope'] }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      bad({ key: 'ok', name: 'x', permissions: ['invoice:read'], managed: true }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(bad({ key: 'ok', name: 'x' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad(undefined), 'AXEDA_INVALID_INPUT');
  });

  it('reserves the super-admin key', async () => {
    const { axeda, admin } = await createFixture();
    await rejectsWith(
      axeda.roles.create(admin, { key: 'super-admin', name: 'x', permissions: ['*'] }),
      'AXEDA_INVALID_INPUT',
    );
  });

  it('enforces the permission limit per role', async () => {
    const { axeda, admin } = await createFixture({
      permissions: ['a:b', 'a:c', 'a:d'],
      limits: { maxPermissionsPerRole: 2 },
    });
    await rejectsWith(
      axeda.roles.create(admin, { key: 'r', name: 'R', permissions: ['a:b', 'a:c', 'a:d'] }),
      'AXEDA_INVALID_INPUT',
    );
  });

  it('rejects a duplicate key', async () => {
    const { axeda, admin, role } = await createFixture();
    await role('cashier', ['invoice:read']);
    await rejectsWith(
      axeda.roles.create(admin, { key: 'cashier', name: 'again', permissions: ['invoice:read'] }),
      'AXEDA_ROLE_KEY_TAKEN',
    );
  });
});

describe('roles: updating (no self-escalation through role edits)', () => {
  async function withManager() {
    const f = await createFixture();
    await f.role('role-admin', ['axeda:role:manage', 'invoice:read']);
    const manager = f.user('manager');
    await f.give('manager', 'role-admin');
    const viewer = await f.role('viewer', ['invoice:read']);
    return { ...f, manager, viewer };
  }

  it('lets a role manager add only permissions they hold', async () => {
    const { axeda, manager, viewer } = await withManager();
    await rejectsWith(
      axeda.roles.update(manager, viewer.id, viewer.version, {
        permissions: ['invoice:read', 'invoice:delete'],
      }),
      'AXEDA_FORBIDDEN',
    );
    const ok = await axeda.roles.update(manager, viewer.id, viewer.version, { name: 'Viewer 2' });
    expect(ok).toMatchObject({ name: 'Viewer 2', version: 2 });
  });

  it('blocks the escalation: a manager cannot add "*" to the role they themselves hold', async () => {
    const { axeda, manager } = await withManager();
    const own = (await axeda.roles.list(manager, { limit: 50 })).items.find(
      (r) => r.key === 'role-admin',
    );
    expect(own).toBeDefined();
    await rejectsWith(
      axeda.roles.update(manager, own?.id ?? '', own?.version ?? 0, { permissions: ['*'] }),
      'AXEDA_FORBIDDEN',
    );
    expect(await axeda.can(manager, 'invoice:delete')).toBe(false);
  });

  it('allows removing permissions even from a role more powerful than the manager', async () => {
    const f = await withManager();
    const strong = await f.role('strong', ['invoice:read', 'invoice:delete']);
    const updated = await f.axeda.roles.update(f.manager, strong.id, strong.version, {
      permissions: ['invoice:read'],
    });
    expect(updated.permissions).toEqual(['invoice:read']);
  });

  it('does not count a permission already covered by a wildcard as an addition', async () => {
    const f = await withManager();
    const wide = await f.role('wide', ['invoice:*']);
    // Quien edita no tiene invoice:update, pero ya estaba cubierto por invoice:*.
    const ok = await f.axeda.roles.update(f.manager, wide.id, wide.version, {
      permissions: ['invoice:*', 'invoice:update'],
    });
    expect(ok.permissions).toContain('invoice:update');
  });

  it('applies optimistic concurrency', async () => {
    const { axeda, admin, viewer } = await withManager();
    await axeda.roles.update(admin, viewer.id, viewer.version, { name: 'first' });
    await rejectsWith(
      axeda.roles.update(admin, viewer.id, viewer.version, { name: 'second' }),
      'AXEDA_VERSION_CONFLICT',
    );
  });

  it('rejects unknown fields and managed roles', async () => {
    const { axeda, admin, viewer } = await withManager();
    await rejectsWith(
      axeda.roles.update(admin, viewer.id, viewer.version, { status: 'inactive' } as never),
      'AXEDA_INVALID_INPUT',
    );
    const managed = (await axeda.roles.list(admin, { limit: 50 })).items.find((r) => r.managed);
    expect(managed?.key).toBe('super-admin');
    await rejectsWith(
      axeda.roles.update(admin, managed?.id ?? '', managed?.version ?? 0, { name: 'hacked' }),
      'AXEDA_ROLE_MANAGED',
    );
    await rejectsWith(axeda.roles.delete(admin, managed?.id ?? ''), 'AXEDA_ROLE_MANAGED');
  });

  it('does not reveal whether a role exists to someone who cannot manage roles', async () => {
    const { axeda, user, viewer } = await withManager();
    const outsider = user('outsider');
    await rejectsWith(
      axeda.roles.update(outsider, viewer.id, viewer.version, { name: 'x' }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      axeda.roles.update(outsider, 'does-not-exist', 1, { name: 'x' }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(axeda.roles.delete(outsider, 'does-not-exist'), 'AXEDA_FORBIDDEN');
  });
});

describe('roles: status and deletion', () => {
  it('requires covering the permissions to reactivate a role', async () => {
    const f = await createFixture();
    await f.role('role-admin', ['axeda:role:manage', 'invoice:read']);
    const manager = f.user('manager');
    await f.give('manager', 'role-admin');
    const strong = await f.role('strong', ['invoice:delete']);
    const off = await f.axeda.roles.setStatus(f.admin, strong.id, strong.version, 'inactive');
    // El gestor puede dejarla inactiva (quita poder) pero no reactivarla (lo devuelve).
    await rejectsWith(
      f.axeda.roles.setStatus(manager, off.id, off.version, 'active'),
      'AXEDA_FORBIDDEN',
    );
    const back = await f.axeda.roles.setStatus(f.admin, off.id, off.version, 'active');
    expect(back.status).toBe('active');
  });

  it('rejects an invalid status', async () => {
    const f = await createFixture();
    const r = await f.role('r', ['invoice:read']);
    await rejectsWith(
      f.axeda.roles.setStatus(f.admin, r.id, r.version, 'archived' as never),
      'AXEDA_INVALID_INPUT',
    );
  });

  it('deleting a role removes its assignments and audits it', async () => {
    const f = await createFixture();
    const r = await f.role('r', ['invoice:read']);
    f.user('alice');
    await f.give('alice', 'r');
    await f.axeda.roles.delete(f.admin, r.id);
    expect(await f.persistence.assignments.listForUser('alice')).toEqual([]);
    const events = await f.axeda.listAudit(f.admin, { action: 'role.delete' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({ targetId: r.id, metadata: { key: 'r' } });
  });

  it('reports a missing role', async () => {
    const f = await createFixture();
    await rejectsWith(f.axeda.roles.delete(f.admin, 'nope'), 'AXEDA_ROLE_NOT_FOUND');
    await rejectsWith(f.axeda.roles.get(f.admin, 'nope'), 'AXEDA_ROLE_NOT_FOUND');
  });
});

describe('roles: reading', () => {
  it('lets role managers and assignment managers read, and nobody else', async () => {
    const f = await createFixture();
    await f.role('assigner', ['axeda:assignment:manage']);
    const r = await f.role('viewer', ['invoice:read']);
    const assigner = f.user('assigner');
    await f.give('assigner', 'assigner', { type: 'company', id: 'A' });
    const outsider = f.user('outsider');

    expect((await f.axeda.roles.list(assigner, { limit: 50 })).items.length).toBeGreaterThan(0);
    expect((await f.axeda.roles.get(assigner, r.id)).key).toBe('viewer');
    await rejectsWith(f.axeda.roles.list(outsider, { limit: 50 }), 'AXEDA_FORBIDDEN');
    await rejectsWith(f.axeda.roles.get(outsider, r.id), 'AXEDA_FORBIDDEN');
  });
});
