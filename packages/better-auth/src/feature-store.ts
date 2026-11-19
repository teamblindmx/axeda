import type { CompanyFeature, FeatureStore } from '@teamblind/axeda-core';
import { isUniqueViolation } from './errors.js';
import { MODELS } from './schema.js';
import { MAX_ROWS, type Adapter } from './shared.js';

interface FeatureRow {
  id: string;
  companyId: string;
  feature: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: Date | string;
}

const model = MODELS.companyFeature;

const toFeature = (row: FeatureRow): CompanyFeature => ({
  companyId: row.companyId,
  feature: row.feature,
  enabled: row.enabled === true,
  updatedBy: row.updatedBy,
  updatedAt: new Date(row.updatedAt),
});

export function createFeatureStore(adapter: Adapter, now: () => Date): FeatureStore {
  const where = (companyId: string, feature: string) => [
    { field: 'companyId', value: companyId },
    { field: 'feature', value: feature },
  ];

  async function update(change: Parameters<FeatureStore['set']>[0], at: Date) {
    return adapter.update<FeatureRow>({
      model,
      where: where(change.companyId, change.feature),
      update: { enabled: change.enabled, updatedBy: change.updatedBy, updatedAt: at },
    });
  }

  return {
    async listForCompanies(companyIds) {
      if (companyIds.length === 0) return [];
      const rows = await adapter.findMany<FeatureRow>({
        model,
        where: [{ field: 'companyId', operator: 'in', value: [...companyIds] }],
        limit: MAX_ROWS,
      });
      return rows.map(toFeature);
    },

    async set(change) {
      const at = now();
      const updated = await update(change, at);
      if (updated !== null) return toFeature(updated);
      try {
        const created = await adapter.create<Omit<FeatureRow, 'id'>, FeatureRow>({
          model,
          data: { ...change, updatedAt: at },
        });
        return toFeature(created);
      } catch (error) {
        // Otro lo creó a la vez: entonces se cambia el suyo.
        if (!isUniqueViolation(error)) throw error;
        const raced = await update(change, at);
        if (raced === null) throw error;
        return toFeature(raced);
      }
    },

    async deleteForCompanies(companyIds) {
      if (companyIds.length === 0) return 0;
      return adapter.deleteMany({
        model,
        where: [{ field: 'companyId', operator: 'in', value: [...companyIds] }],
      });
    },
  };
}
