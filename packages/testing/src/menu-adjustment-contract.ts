import type { AxedaPersistence, MenuAdjustmentChange } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';

const change = (overrides: Partial<MenuAdjustmentChange> = {}): MenuAdjustmentChange => ({
  companyId: null,
  itemKey: 'invoices',
  hidden: null,
  order: null,
  labels: null,
  updatedBy: 'u1',
  ...overrides,
});

/** Pruebas de contrato de los ajustes del menú (parte de `runPersistenceContract`). */
export function defineMenuAdjustmentContract(database: () => AxedaPersistence): void {
  describe('menu adjustments', () => {
    it('keeps global and company adjustments apart, and reads every field back', async () => {
      const store = database().menuAdjustments;
      const saved = await store.set(
        change({ hidden: true, order: 3, labels: { es: 'Facturas', '*': 'Invoices' } }),
      );
      expect(saved).toMatchObject({
        companyId: null,
        itemKey: 'invoices',
        hidden: true,
        order: 3,
        labels: { es: 'Facturas', '*': 'Invoices' },
        updatedBy: 'u1',
      });
      await store.set(change({ companyId: 'c1', order: -1 }));
      await store.set(change({ companyId: 'c1', itemKey: 'reports', hidden: false }));
      expect(await store.list(null)).toEqual([saved]);
      expect(
        (await store.list('c1')).map((item) => [item.itemKey, item.hidden, item.order]),
      ).toEqual([
        ['invoices', null, -1],
        ['reports', false, null],
      ]);
      expect(await store.list('c2')).toEqual([]);
    });

    it('replaces an adjustment instead of keeping two, even when set at the same time', async () => {
      const store = database().menuAdjustments;
      await store.set(change({ hidden: true, labels: { '*': 'Old' } }));
      await store.set(change({ order: 2 }));
      expect(await store.list(null)).toMatchObject([{ hidden: null, order: 2, labels: null }]);
      await Promise.all([1, 2, 3, 4].map((order) => store.set(change({ companyId: 'c1', order }))));
      expect(await store.list('c1')).toHaveLength(1);
    });

    it('deletes one adjustment, and those of purged companies only', async () => {
      const store = database().menuAdjustments;
      await store.set(change());
      await store.set(change({ companyId: 'c1' }));
      await store.set(change({ companyId: 'c2' }));
      expect(await store.delete('c1', 'invoices')).toBe(true);
      expect(await store.delete('c1', 'invoices')).toBe(false);
      expect(await store.deleteForCompanies(['c2'])).toBe(1);
      // Los globales no son de ninguna compañía.
      expect(await store.list(null)).toHaveLength(1);
      expect(await store.deleteForCompanies([])).toBe(0);
    });
  });
}
