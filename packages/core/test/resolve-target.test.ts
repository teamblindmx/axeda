import { describe, expect, it } from 'vitest';
import { createFixture, BASE_OPTIONS } from './fixture.js';

describe('resolveTarget (the scope of a request, read from the database)', () => {
  it('global needs no lookup', async () => {
    const f = await createFixture(BASE_OPTIONS);
    expect(await f.axeda.resolveTarget({ type: 'global' })).toEqual({ type: 'global' });
  });

  it('a company resolves to itself, and an unknown one is null', async () => {
    const f = await createFixture(BASE_OPTIONS);
    const acme = await f.company('acme');
    expect(await f.axeda.resolveTarget({ type: 'company', id: acme.id })).toEqual({
      type: 'company',
      companyId: acme.id,
    });
    expect(await f.axeda.resolveTarget({ type: 'company', id: 'nope' })).toBeNull();
  });

  it('a business gets its company from the database, never from the caller', async () => {
    const f = await createFixture(BASE_OPTIONS);
    const acme = await f.company('acme');
    await f.company('globex');
    const shop = await f.business('shop', acme.id);
    expect(await f.axeda.resolveTarget({ type: 'business', id: shop.id })).toEqual({
      type: 'business',
      companyId: acme.id,
      businessId: shop.id,
    });
    expect(await f.axeda.resolveTarget({ type: 'business', id: 'nope' })).toBeNull();
  });

  it('the resolved target is what `can` needs: access in one company does not reach another', async () => {
    const f = await createFixture(BASE_OPTIONS);
    const acme = await f.company('acme');
    const globex = await f.company('globex');
    const shop = await f.business('shop', globex.id);
    await f.role('cashier', ['invoice:read']);
    const ana = f.user('ana');
    await f.give('ana', 'cashier', { type: 'company', id: acme.id });

    const own = await f.axeda.resolveTarget({ type: 'company', id: acme.id });
    const other = await f.axeda.resolveTarget({ type: 'business', id: shop.id });
    expect(own).not.toBeNull();
    expect(other).not.toBeNull();
    expect(await f.axeda.can(ana, 'invoice:read', own ?? undefined)).toBe(true);
    // El negocio es de Globex: aunque la petición dijera otra cosa, la compañía sale de la base.
    expect(await f.axeda.can(ana, 'invoice:read', other ?? undefined)).toBe(false);
  });

  it('an inactive company still resolves, and `can` denies inside it', async () => {
    const f = await createFixture(BASE_OPTIONS);
    const acme = await f.company('acme');
    await f.role('cashier', ['invoice:read']);
    const ana = f.user('ana');
    await f.give('ana', 'cashier', { type: 'company', id: acme.id });
    await f.axeda.companies.setStatus(f.admin, acme.id, acme.version, 'inactive');

    const target = await f.axeda.resolveTarget({ type: 'company', id: acme.id });
    expect(target).toEqual({ type: 'company', companyId: acme.id });
    expect(await f.axeda.can(ana, 'invoice:read', target ?? undefined)).toBe(false);
  });
});
