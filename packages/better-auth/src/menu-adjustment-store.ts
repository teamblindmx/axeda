import type { MenuAdjustmentStore, StoredMenuAdjustment } from '@teamblind/axeda-core';
import { isUniqueViolation } from './errors.js';
import { MODELS } from './schema.js';
import { MAX_ROWS, type Adapter } from './shared.js';

/** Valor de `companyId` de un ajuste global: vacío, porque un índice único no iguala los `NULL`. */
const GLOBAL = '';

interface AdjustmentRow {
  id: string;
  companyId: string;
  itemKey: string;
  hidden?: boolean | null;
  sortOrder?: number | null;
  labels?: Record<string, string> | string | null;
  updatedBy: string;
  updatedAt: Date | string;
}

const model = MODELS.menuAdjustment;

/** Algunos adaptadores devuelven el JSON como texto. */
const labelsOf = (raw: AdjustmentRow['labels']): Record<string, string> | null => {
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, string>) : raw;
};

const toAdjustment = (row: AdjustmentRow): StoredMenuAdjustment => ({
  companyId: row.companyId === GLOBAL ? null : row.companyId,
  itemKey: row.itemKey,
  hidden: row.hidden ?? null,
  order: row.sortOrder ?? null,
  labels: labelsOf(row.labels),
  updatedBy: row.updatedBy,
  updatedAt: new Date(row.updatedAt),
});

export function createMenuAdjustmentStore(adapter: Adapter, now: () => Date): MenuAdjustmentStore {
  const where = (companyId: string | null, itemKey: string) => [
    { field: 'companyId', value: companyId ?? GLOBAL },
    { field: 'itemKey', value: itemKey },
  ];

  return {
    async list(companyId) {
      const rows = await adapter.findMany<AdjustmentRow>({
        model,
        where: [{ field: 'companyId', value: companyId ?? GLOBAL }],
        sortBy: { field: 'itemKey', direction: 'asc' },
        limit: MAX_ROWS,
      });
      return rows.map(toAdjustment);
    },

    async set(change) {
      const values = {
        hidden: change.hidden,
        sortOrder: change.order,
        labels: change.labels === null ? null : { ...change.labels },
        updatedBy: change.updatedBy,
        updatedAt: now(),
      };
      const replace = () =>
        adapter.update<AdjustmentRow>({
          model,
          where: where(change.companyId, change.itemKey),
          update: values,
        });
      const updated = await replace();
      if (updated !== null) return toAdjustment(updated);
      try {
        const created = await adapter.create<Omit<AdjustmentRow, 'id'>, AdjustmentRow>({
          model,
          data: { companyId: change.companyId ?? GLOBAL, itemKey: change.itemKey, ...values },
        });
        return toAdjustment(created);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await replace();
        if (raced === null) throw error;
        return toAdjustment(raced);
      }
    },

    async delete(companyId, itemKey) {
      return (await adapter.deleteMany({ model, where: where(companyId, itemKey) })) > 0;
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
