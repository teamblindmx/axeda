import { describe, expect, it } from 'vitest';
import { isAxedaError, type AxedaErrorCode, type AxedaOptions } from '../src/index.js';
import { createFixture } from './fixture.js';

const DAY = 86_400_000;
const OPTIONS = {
  permissions: ['inventory:read', 'invoice:read'],
  features: {
    inventory: { permissions: ['inventory:*'], name: 'Inventory', description: 'Stock control' },
    billing: { permissions: ['invoice:read'], enabledByDefault: true },
  },
} satisfies AxedaOptions;

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
};

async function world() {
  const f = await createFixture(OPTIONS);
  await f.company('A');
  await f.company('B');
  await f.role('stock', ['inventory:*']);
  await f.role('company-admin', ['axeda:company:manage', 'axeda:assignment:manage']);
  f.user('ana');
  await f.give('ana', 'stock', { type: 'company', id: 'A' });
  const owner = f.user('owner');
  await f.give('owner', 'company-admin', { type: 'company', id: 'A' });
  return { ...f, owner };
}

describe('features per company', () => {
  it('lists every declared feature with its state, for whoever sees the company', async () => {
    const w = await world();
    expect(await w.axeda.features.list(w.owner, 'A')).toEqual([
      {
        key: 'inventory',
        name: 'Inventory',
        description: 'Stock control',
        enabled: false,
        source: 'default',
      },
      { key: 'billing', name: 'billing', description: null, enabled: true, source: 'default' },
    ]);
    await rejectsWith(w.axeda.features.list(w.owner, 'B'), 'AXEDA_COMPANY_NOT_FOUND');
  });

  it('lets the platform switch one on, with an effect on the next check', async () => {
    const w = await world();
    const inA = { type: 'company', companyId: 'A' } as const;
    expect(await w.axeda.can({ userId: 'ana' }, 'inventory:read', inA)).toBe(false);
    const state = await w.axeda.features.set(w.admin, 'A', 'inventory', true);
    expect(state).toMatchObject({ key: 'inventory', enabled: true, source: 'set' });
    expect(await w.axeda.hasFeature('A', 'inventory')).toBe(true);
    expect(await w.axeda.hasFeature('B', 'inventory')).toBe(false);
    // Sin esperar a ninguna caché.
    expect(await w.axeda.can({ userId: 'ana' }, 'inventory:read', inA)).toBe(true);
    await w.axeda.features.set(w.admin, 'A', 'inventory', false);
    expect(await w.axeda.can({ userId: 'ana' }, 'inventory:read', inA)).toBe(false);
    const events = await w.axeda.listAudit(w.admin, { action: 'feature.set' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({
      actorId: 'admin',
      targetType: 'company',
      targetId: 'A',
      metadata: { feature: 'inventory', enabled: false },
      outcome: 'success',
    });
  });

  it('does not let a company switch its own features, and audits the attempt', async () => {
    const w = await world();
    await rejectsWith(w.axeda.features.set(w.owner, 'A', 'inventory', true), 'AXEDA_FORBIDDEN');
    expect(await w.axeda.hasFeature('A', 'inventory')).toBe(false);
    const events = await w.axeda.listAudit(w.admin, { action: 'feature.set' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({ actorId: 'owner', outcome: 'denied' });
  });

  it('refuses unknown features, companies and values', async () => {
    const w = await world();
    await rejectsWith(w.axeda.features.set(w.admin, 'A', 'inventroy', true), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      w.axeda.features.set(w.admin, 'ghost', 'inventory', true),
      'AXEDA_COMPANY_NOT_FOUND',
    );
    await rejectsWith(
      w.axeda.features.set(w.admin, 'A', 'inventory', 'yes' as never),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(w.axeda.hasFeature('A', 'nope'), 'AXEDA_INVALID_INPUT');
  });

  it('forgets the state of a company that is purged', async () => {
    const w = await world();
    await w.axeda.features.set(w.admin, 'A', 'inventory', true);
    const company = await w.persistence.companies.get('A');
    await w.axeda.companies.delete(w.admin, 'A', company?.version ?? 0);
    w.clock.current = new Date(w.clock.current.getTime() + 31 * DAY);
    await w.axeda.purgeDeleted();
    expect(await w.persistence.features.listForCompanies(['A'])).toEqual([]);
  });
});
