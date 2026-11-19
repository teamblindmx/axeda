import { describe, expect, it } from 'vitest';
import { isAxedaError, SUPER_ADMIN_ROLE_KEY } from '../src/index.js';
import { createFixture } from './fixture.js';

const acme = { type: 'company', id: 'A' } as const;
const inAcme = { type: 'company', companyId: 'A' } as const;

async function world() {
  const f = await createFixture();
  await f.company('A');
  f.user('waiter');
  f.user('manager');
  await f.persistence.staff.create({
    userId: 'waiter',
    companyId: 'A',
    businessId: null,
    siteId: null,
    username: 'mesero1',
    pinHash: 'x',
    createdBy: 'admin',
  });
  const waiterRole = await f.role('waiter', ['invoice:read', 'invoice:create']);
  const everything = await f.role('all-invoices', ['invoice:*']);
  const boss = await f.role('boss', ['invoice:read', 'axeda:assignment:manage']);
  const assign = (userId: string, roleId: string) =>
    f.axeda.assignments.assign(f.admin, { userId, roleId, scope: acme });
  return { ...f, waiterRole, everything, boss, assign };
}

const deniedWith = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, 'AXEDA_FORBIDDEN'), String(error)).toBe(true);
  return (error as { details: Record<string, unknown> }).details;
};

describe('a staff account (username and PIN) never administers Axeda', () => {
  it('can receive working roles, wildcards of the application included', async () => {
    const w = await world();
    await w.assign('waiter', w.waiterRole.id);
    await w.assign('waiter', w.everything.id);
    expect(await w.axeda.can({ userId: 'waiter' }, 'invoice:delete', inAcme)).toBe(true);
  });

  it('cannot receive a role with an Axeda permission, and is told why', async () => {
    const w = await world();
    const details = await deniedWith(w.assign('waiter', w.boss.id));
    expect(details).toMatchObject({
      reason: 'pin_account_cannot_administer',
      permissions: ['axeda:assignment:manage'],
    });
    // A una cuenta completa sí se le puede dar.
    await w.assign('manager', w.boss.id);
  });

  it('cannot receive the total wildcard either', async () => {
    const w = await world();
    const superAdmin = await w.persistence.roles.getByKey(SUPER_ADMIN_ROLE_KEY);
    const error = await w.axeda.assignments
      .assign(w.admin, {
        userId: 'waiter',
        roleId: superAdmin?.id ?? '',
        scope: { type: 'global' },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(isAxedaError(error, 'AXEDA_FORBIDDEN')).toBe(true);
  });

  it('gains nothing administrative if one of its roles is edited later', async () => {
    const w = await world();
    await w.assign('waiter', w.waiterRole.id);
    await w.assign('manager', w.waiterRole.id);
    await w.axeda.roles.update(w.admin, w.waiterRole.id, w.waiterRole.version, {
      permissions: [
        'invoice:read',
        'invoice:create',
        'axeda:assignment:manage',
        'axeda:audit:read',
      ],
    });
    // La cuenta completa gana el permiso; la de personal no, pero conserva los de trabajo.
    expect(await w.axeda.can({ userId: 'manager' }, 'axeda:assignment:manage', inAcme)).toBe(true);
    expect(await w.axeda.can({ userId: 'waiter' }, 'axeda:assignment:manage', inAcme)).toBe(false);
    expect(await w.axeda.can({ userId: 'waiter' }, 'axeda:audit:read', inAcme)).toBe(false);
    expect(await w.axeda.can({ userId: 'waiter' }, 'invoice:create', inAcme)).toBe(true);
    // Y tampoco puede usarlo para administrar.
    await deniedWith(
      w.axeda.assignments.assign(
        { userId: 'waiter' },
        { userId: 'manager', roleId: w.waiterRole.id, scope: acme },
      ),
    );
  });

  it('decides from the stores, not from anything the request says', async () => {
    const w = await world();
    await w.assign('waiter', w.everything.id);
    // Aunque la cuenta deje de ser de personal, solo cuenta lo que dicen los almacenes.
    await w.persistence.staff.delete('waiter');
    await w.persistence.authz.bumpUserVersion('waiter');
    await w.assign('waiter', w.boss.id);
    expect(await w.axeda.can({ userId: 'waiter' }, 'axeda:assignment:manage', inAcme)).toBe(true);
  });
});
