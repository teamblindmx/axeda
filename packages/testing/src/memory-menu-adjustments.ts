import type { MenuAdjustmentStore, StoredMenuAdjustment } from '@teamblind/axeda-core';
import type { Run } from './memory-tenants.js';

export interface MenuAdjustmentState {
  menuAdjustments: Map<string, StoredMenuAdjustment>;
}

const keyOf = (companyId: string | null, itemKey: string) => `${companyId ?? ''}\u0000${itemKey}`;

/** Ajustes del menú en memoria (parte de `createMemoryPersistence`). */
export function createMenuAdjustmentStore(
  state: MenuAdjustmentState,
  run: Run,
  now: () => Date,
): MenuAdjustmentStore {
  return {
    list: (companyId) =>
      run(async () =>
        [...state.menuAdjustments.values()]
          .filter((item) => item.companyId === companyId)
          .sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
      ),
    set: (change) =>
      run(async () => {
        const item: StoredMenuAdjustment = {
          ...change,
          labels: change.labels === null ? null : { ...change.labels },
          updatedAt: now(),
        };
        state.menuAdjustments.set(keyOf(change.companyId, change.itemKey), item);
        return item;
      }),
    delete: (companyId, itemKey) =>
      run(async () => state.menuAdjustments.delete(keyOf(companyId, itemKey))),
    deleteForCompanies: (companyIds) =>
      run(async () => {
        let removed = 0;
        for (const [key, item] of state.menuAdjustments) {
          if (item.companyId !== null && companyIds.includes(item.companyId)) {
            state.menuAdjustments.delete(key);
            removed += 1;
          }
        }
        return removed;
      }),
  };
}
