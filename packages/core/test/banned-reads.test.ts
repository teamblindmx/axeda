import { describe, expect, it } from 'vitest';
import { isAxedaError } from '../src/index.js';
import { createFixture } from './fixture.js';

/**
 * Un usuario bloqueado no puede NADA, ni administrar ni consultar (ADR-0015): llega por una vía
 * sin sesión (p. ej. una llave de API) con `banned: true` en su `Principal`. Cada consulta
 * se prueba con una persona que sin el bloqueo sí podría hacerla.
 */
async function world() {
  const f = await createFixture();
  const acme = await f.company('acme');
  const shop = await f.business('shop', acme.id);
  await f.role('cashier', ['invoice:read']);
  f.user('ana');
  await f.give('ana', 'cashier', { type: 'company', id: acme.id });
  // La administración global, y la misma persona bloqueada.
  const bannedAdmin = { ...f.admin, banned: true };
  return { f, acme, shop, bannedAdmin };
}

const denied = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'allowed';
  } catch (error) {
    return isAxedaError(error) ? error.code : 'unexpected error';
  }
};

describe('a banned principal can neither read nor manage', () => {
  it('control: the same administrator, not banned, can do all of this', async () => {
    const { f, acme } = await world();
    expect(await denied(f.axeda.roles.list(f.admin, { limit: 10 }))).toBe('allowed');
    expect(await denied(f.axeda.companies.list(f.admin, {}, { limit: 10 }))).toBe('allowed');
    expect(await denied(f.axeda.companies.get(f.admin, acme.id))).toBe('allowed');
    const others = await f.axeda.assignments.listForUser(f.admin, 'ana');
    expect(others).toHaveLength(1);
  });

  it('cannot list or read roles', async () => {
    const { f, bannedAdmin } = await world();
    const roles = await f.axeda.roles.list(f.admin, { limit: 10 });
    expect(await denied(f.axeda.roles.list(bannedAdmin, { limit: 10 }))).toBe('AXEDA_FORBIDDEN');
    expect(await denied(f.axeda.roles.get(bannedAdmin, roles.items[0]?.id ?? ''))).toBe(
      'AXEDA_FORBIDDEN',
    );
  });

  it('cannot list or read companies and businesses it is a member of', async () => {
    const { f, acme, shop, bannedAdmin } = await world();
    const listed = await f.axeda.companies.list(bannedAdmin, {}, { limit: 10 }).catch(() => null);
    expect(listed?.items ?? []).toEqual([]);
    expect(await denied(f.axeda.companies.get(bannedAdmin, acme.id))).not.toBe('allowed');
    expect(await denied(f.axeda.businesses.get(bannedAdmin, shop.id))).not.toBe('allowed');
    const businesses = await f.axeda.businesses
      .list(bannedAdmin, acme.id, {}, { limit: 10 })
      .catch(() => null);
    expect(businesses?.items ?? []).toEqual([]);
  });

  it("cannot see another person's assignments", async () => {
    const { f, bannedAdmin } = await world();
    expect(await f.axeda.assignments.listForUser(bannedAdmin, 'ana')).toEqual([]);
  });

  it('the roles, companies and assignments are still there for everyone else', async () => {
    const { f, acme } = await world();
    expect((await f.axeda.roles.list(f.admin, { limit: 10 })).items.length).toBeGreaterThan(0);
    expect((await f.axeda.companies.get(f.admin, acme.id)).id).toBe(acme.id);
  });
});
