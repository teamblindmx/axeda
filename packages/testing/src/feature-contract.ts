import type { AxedaPersistence } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';

/** Pruebas de contrato del estado de las funcionalidades (parte de `runPersistenceContract`). */
export function defineFeatureContract(database: () => AxedaPersistence): void {
  describe('company features', () => {
    it('sets, changes and lists the state of a feature per company', async () => {
      const features = database().features;
      expect(await features.listForCompanies(['c1'])).toEqual([]);
      const on = await features.set({
        companyId: 'c1',
        feature: 'inventory',
        enabled: true,
        updatedBy: 'u1',
      });
      expect(on).toMatchObject({
        companyId: 'c1',
        feature: 'inventory',
        enabled: true,
        updatedBy: 'u1',
      });
      expect(on.updatedAt).toBeInstanceOf(Date);
      await features.set({
        companyId: 'c1',
        feature: 'inventory',
        enabled: false,
        updatedBy: 'u2',
      });
      await features.set({ companyId: 'c1', feature: 'reports', enabled: true, updatedBy: 'u1' });
      await features.set({ companyId: 'c2', feature: 'inventory', enabled: true, updatedBy: 'u1' });
      const listed = await features.listForCompanies(['c1']);
      expect(listed.map((item) => [item.feature, item.enabled, item.updatedBy]).sort()).toEqual([
        ['inventory', false, 'u2'],
        ['reports', true, 'u1'],
      ]);
      expect(await features.listForCompanies(['c1', 'c2'])).toHaveLength(3);
      expect(await features.listForCompanies([])).toEqual([]);
    });

    it('keeps one state per company and feature, even when set at the same time', async () => {
      const features = database().features;
      await Promise.all(
        [true, false, true, false].map((enabled) =>
          features.set({ companyId: 'c1', feature: 'inventory', enabled, updatedBy: 'u1' }),
        ),
      );
      expect(await features.listForCompanies(['c1'])).toHaveLength(1);
    });

    it('deletes the state of purged companies only', async () => {
      const features = database().features;
      await features.set({ companyId: 'c1', feature: 'inventory', enabled: true, updatedBy: 'u1' });
      await features.set({ companyId: 'c1', feature: 'reports', enabled: true, updatedBy: 'u1' });
      await features.set({ companyId: 'c2', feature: 'inventory', enabled: true, updatedBy: 'u1' });
      expect(await features.deleteForCompanies(['c1'])).toBe(2);
      expect(await features.listForCompanies(['c1', 'c2'])).toHaveLength(1);
      expect(await features.deleteForCompanies([])).toBe(0);
    });

    it('rolls back with the transaction', async () => {
      await database()
        .transaction(async (stores) => {
          await stores.features.set({
            companyId: 'c1',
            feature: 'inventory',
            enabled: true,
            updatedBy: 'u1',
          });
          throw new Error('rollback');
        })
        .catch(() => undefined);
      expect(await database().features.listForCompanies(['c1'])).toEqual([]);
    });
  });
}
