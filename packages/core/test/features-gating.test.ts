import { describe, expect, it } from 'vitest';
import { isAxedaError, type AxedaOptions, type TargetScope } from '../src/index.js';
import { createFixture } from './fixture.js';

const OPTIONS = {
  permissions: ['inventory:read', 'inventory:write', 'invoice:read', 'invoice:create'],
  features: {
    inventory: { permissions: ['inventory:*'], name: 'Inventory' },
    billing: { permissions: ['invoice:create'], enabledByDefault: true },
  },
  menus: [
    { key: 'stock', label: 'Stock', path: '/stock', requires: 'inventory:read' },
    { key: 'bills', label: 'Bills', path: '/bills', requires: 'invoice:read' },
  ],
} satisfies AxedaOptions;

const inCompany = (companyId: string): TargetScope => ({ type: 'company', companyId });

/** A tiene inventario (lo encendió la plataforma); B no. Las dos tienen facturación por omisión. */
async function world() {
  const f = await createFixture(OPTIONS);
  await f.company('A');
  await f.company('B');
  await f.business('shopB', 'B');
  await f.persistence.features.set({
    companyId: 'A',
    feature: 'inventory',
    enabled: true,
    updatedBy: 'admin',
  });
  await f.role('stock', ['inventory:*', 'invoice:read']);
  // El comodín total solo se asigna en global: el dueño de una compañía tiene comodines por módulo.
  await f.role('owner', ['inventory:*', 'invoice:*', 'axeda:assignment:manage']);
  f.user('ana');
  f.user('beto');
  return f;
}

describe('the permissions of a feature a company does not have', () => {
  it('count where the company has the feature, and not where it does not', async () => {
    const w = await world();
    await w.give('ana', 'stock', { type: 'company', id: 'A' });
    await w.give('beto', 'stock', { type: 'company', id: 'B' });
    expect(await w.axeda.can({ userId: 'ana' }, 'inventory:write', inCompany('A'))).toBe(true);
    expect(await w.axeda.can({ userId: 'beto' }, 'inventory:write', inCompany('B'))).toBe(false);
    // Lo que no depende de la funcionalidad sigue valiendo.
    expect(await w.axeda.can({ userId: 'beto' }, 'invoice:read', inCompany('B'))).toBe(true);
    // También más abajo: un negocio de B.
    await w.give('beto', 'stock', { type: 'business', id: 'shopB' });
    expect(
      await w.axeda.can({ userId: 'beto' }, 'inventory:read', {
        type: 'business',
        companyId: 'B',
        businessId: 'shopB',
      }),
    ).toBe(false);
  });

  it('cut a wildcard, but never Axeda administration', async () => {
    const w = await world();
    await w.give('beto', 'owner', { type: 'company', id: 'B' });
    const held = await w.axeda.effectivePermissions({ userId: 'beto' }, inCompany('B'));
    expect(held.allows('inventory:read' as never)).toBe(false);
    expect(held.allows('invoice:create' as never)).toBe(true);
    expect(held.allows('axeda:assignment:manage' as never)).toBe(true);
    expect(held.concrete(w.axeda.catalog)).not.toContain('inventory:read');
    expect(held.concrete(w.axeda.catalog)).toContain('invoice:read');
  });

  it('do not limit global assignments: those are the platform', async () => {
    const w = await world();
    await w.give('ana', 'stock');
    expect(await w.axeda.can({ userId: 'ana' }, 'inventory:write', inCompany('B'))).toBe(true);
  });

  it('follow the default, and a company can be switched off', async () => {
    const w = await world();
    await w.give('ana', 'owner', { type: 'company', id: 'A' });
    expect(await w.axeda.can({ userId: 'ana' }, 'invoice:create', inCompany('A'))).toBe(true);
    await w.persistence.features.set({
      companyId: 'A',
      feature: 'billing',
      enabled: false,
      updatedBy: 'admin',
    });
    // Cambiar una funcionalidad sube la versión de política (lo hará el servicio): aquí, a mano.
    await w.persistence.authz.bumpPolicyVersion();
    expect(await w.axeda.can({ userId: 'ana' }, 'invoice:create', inCompany('A'))).toBe(false);
    expect(await w.axeda.can({ userId: 'ana' }, 'invoice:read', inCompany('A'))).toBe(true);
  });

  it('are left out of scopesFor and scopeFilter', async () => {
    const w = await world();
    await w.give('ana', 'stock', { type: 'company', id: 'A' });
    await w.give('ana', 'stock', { type: 'company', id: 'B' });
    expect(await w.axeda.scopesFor({ userId: 'ana' }, 'inventory:read')).toEqual([
      { type: 'company', id: 'A' },
    ]);
    expect((await w.axeda.scopeFilter({ userId: 'ana' }, 'inventory:read')).companyIds).toEqual([
      'A',
    ]);
    expect(
      [...(await w.axeda.scopeFilter({ userId: 'ana' }, 'invoice:read')).companyIds].sort(),
    ).toEqual(['A', 'B']);
  });

  it('cannot be granted where the granter does not have them', async () => {
    const w = await world();
    await w.give('beto', 'owner', { type: 'company', id: 'B' });
    const stock = await w.persistence.roles.getByKey('stock');
    const error = await w.axeda.assignments
      .assign(
        { userId: 'beto' },
        { userId: 'ana', roleId: stock?.id ?? '', scope: { type: 'company', id: 'B' } },
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(isAxedaError(error, 'AXEDA_FORBIDDEN')).toBe(true);
  });

  it('disappear from the menu of that company', async () => {
    const w = await world();
    await w.give('ana', 'stock', { type: 'company', id: 'A' });
    await w.give('ana', 'stock', { type: 'company', id: 'B' });
    const ids = async (company: string) =>
      (await w.axeda.menu({ userId: 'ana' }, { scope: { type: 'company', id: company } })).map(
        (item) => item.key,
      );
    expect(await ids('A')).toEqual(['bills', 'stock']);
    expect(await ids('B')).toEqual(['bills']);
  });
});
