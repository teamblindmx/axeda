import type { CompanyFeature, FeatureStore } from '@teamblind/axeda-core';
import type { Run } from './memory-tenants.js';

export interface FeatureState {
  features: Map<string, CompanyFeature>;
}

const keyOf = (companyId: string, feature: string) => `${companyId}\u0000${feature}`;

/** Estado de las funcionalidades por compañía en memoria (parte de `createMemoryPersistence`). */
export function createFeatureStore(state: FeatureState, run: Run, now: () => Date): FeatureStore {
  return {
    listForCompanies: (companyIds) =>
      run(async () =>
        [...state.features.values()]
          .filter((item) => companyIds.includes(item.companyId))
          .sort((a, b) =>
            keyOf(a.companyId, a.feature).localeCompare(keyOf(b.companyId, b.feature)),
          ),
      ),
    set: (change) =>
      run(async () => {
        const item: CompanyFeature = { ...change, updatedAt: now() };
        state.features.set(keyOf(change.companyId, change.feature), item);
        return item;
      }),
    deleteForCompanies: (companyIds) =>
      run(async () => {
        let removed = 0;
        for (const [key, item] of state.features) {
          if (companyIds.includes(item.companyId)) {
            state.features.delete(key);
            removed += 1;
          }
        }
        return removed;
      }),
  };
}
