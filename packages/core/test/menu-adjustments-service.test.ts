import { describe, expect, it } from 'vitest';
import { isAxedaError, type Actor, type AxedaErrorCode, type AxedaOptions } from '../src/index.js';
import { createFixture } from './fixture.js';

const DAY = 86_400_000;
const OPTIONS = {
  permissions: ['invoice:read', 'report:read'],
  menus: [
    {
      key: 'invoices',
      label: { es: 'Facturas', en: 'Invoices' },
      path: '/invoices',
      requires: 'invoice:read',
      order: 1,
    },
    { key: 'reports', label: 'Reports', path: '/reports', requires: 'report:read', order: 2 },
  ],
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
  await f.business('shopA', 'A');
  await f.role('reader', ['invoice:read', 'report:read']);
  await f.role('menu-admin', ['axeda:menu:manage']);
  f.user('ana');
  await f.give('ana', 'reader');
  const owner = f.user('owner');
  await f.give('owner', 'menu-admin', { type: 'company', id: 'A' });
  const menuOf = async (scope?: { type: 'company' | 'business'; id: string }, locale = 'es') =>
    (await f.axeda.menu({ userId: 'ana' }, { ...(scope ? { scope } : {}), locale })).map(
      (node) => `${node.key}:${node.label}`,
    );
  return { ...f, owner, menuOf };
}

describe('adjusting the menu through the API', () => {
  it('applies a global adjustment for everyone, and a company one only inside it', async () => {
    const w = await world();
    await w.axeda.menuAdjustments.set(w.admin, {
      level: { type: 'global' },
      itemKey: 'invoices',
      label: { es: 'Cobros', en: 'Billing' },
    });
    await w.axeda.menuAdjustments.set(w.owner, {
      level: { type: 'company', id: 'A' },
      itemKey: 'reports',
      order: 0,
    });
    expect(await w.menuOf()).toEqual(['invoices:Cobros', 'reports:Reports']);
    expect(await w.menuOf({ type: 'company', id: 'A' })).toEqual([
      'reports:Reports',
      'invoices:Cobros',
    ]);
    // Un negocio hereda el menú de su compañía.
    expect(await w.menuOf({ type: 'business', id: 'shopA' })).toEqual([
      'reports:Reports',
      'invoices:Cobros',
    ]);
    expect(await w.menuOf({ type: 'company', id: 'B' })).toEqual([
      'invoices:Cobros',
      'reports:Reports',
    ]);
  });

  it('hides an item, and a reset brings back what the code says', async () => {
    const w = await world();
    const level = { type: 'company', id: 'A' } as const;
    await w.axeda.menuAdjustments.set(w.owner, { level, itemKey: 'reports', hidden: true });
    expect(await w.menuOf({ type: 'company', id: 'A' })).toEqual(['invoices:Facturas']);
    expect(await w.axeda.menuAdjustments.list(w.owner, level)).toMatchObject([
      { companyId: 'A', itemKey: 'reports', hidden: true, order: null, labels: null },
    ]);
    await w.axeda.menuAdjustments.reset(w.owner, level, 'reports');
    expect(await w.menuOf({ type: 'company', id: 'A' })).toEqual([
      'invoices:Facturas',
      'reports:Reports',
    ]);
    const events = await w.axeda.listAudit(w.admin, { targetType: 'menu' }, { limit: 5 });
    expect(events.items.map((event) => event.action)).toEqual(['menu.reset', 'menu.adjust']);
  });

  it('never shows an item without its permission, whatever the adjustment', async () => {
    const w = await world();
    // Quien ajusta el menú no gana los permisos de sus opciones.
    const nobody: Actor = w.user('nobody');
    await w.give('nobody', 'menu-admin', { type: 'company', id: 'A' });
    await w.axeda.menuAdjustments.set(nobody, {
      level: { type: 'company', id: 'A' },
      itemKey: 'reports',
      hidden: false,
      label: 'Visible?',
    });
    expect(await w.axeda.menu(nobody, { scope: { type: 'company', id: 'A' } })).toEqual([]);
  });

  it('only lets each level be adjusted by who manages it, and audits refusals', async () => {
    const w = await world();
    await rejectsWith(
      w.axeda.menuAdjustments.set(w.owner, {
        level: { type: 'global' },
        itemKey: 'reports',
        hidden: true,
      }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      w.axeda.menuAdjustments.set(w.owner, {
        level: { type: 'company', id: 'B' },
        itemKey: 'reports',
        hidden: true,
      }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(w.axeda.menuAdjustments.list(w.owner, { type: 'global' }), 'AXEDA_FORBIDDEN');
    const denied = await w.axeda.listAudit(w.admin, { action: 'menu.adjust' }, { limit: 5 });
    expect(denied.items.map((event) => event.outcome)).toEqual(['denied', 'denied']);
  });

  it('only adjusts items declared in code, and only what can be adjusted', async () => {
    const w = await world();
    const level = { type: 'company', id: 'A' } as const;
    const bad = (input: Record<string, unknown>) =>
      w.axeda.menuAdjustments.set(w.owner, { level, ...input } as never);
    await rejectsWith(bad({ itemKey: 'evil', label: 'Click me' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad({ itemKey: 'reports' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      bad({ itemKey: 'reports', path: 'https://evil.example' }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(bad({ itemKey: 'reports', requires: 'invoice:read' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad({ itemKey: 'reports', label: '' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad({ itemKey: 'reports', order: 1.5 }), 'AXEDA_INVALID_INPUT');
  });

  it('forgets the adjustments of a company that is purged', async () => {
    const w = await world();
    await w.axeda.menuAdjustments.set(w.owner, {
      level: { type: 'company', id: 'A' },
      itemKey: 'reports',
      hidden: true,
    });
    const company = await w.persistence.companies.get('A');
    await w.axeda.companies.delete(w.admin, 'A', company?.version ?? 0);
    w.clock.current = new Date(w.clock.current.getTime() + 31 * DAY);
    await w.axeda.purgeDeleted();
    expect(await w.persistence.menuAdjustments.list('A')).toEqual([]);
  });
});
