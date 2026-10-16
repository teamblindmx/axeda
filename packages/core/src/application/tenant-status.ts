import type { AssignmentScope, TargetScope } from '../domain/scope.js';
import { businessKey, companyKey, isUsable } from '../domain/tenant.js';
import type { AxedaStores } from '../ports/persistence.js';

type TenantStores = Pick<AxedaStores, 'companies' | 'businesses'>;

export interface TenantIds {
  readonly companyIds: ReadonlySet<string>;
  readonly businessIds: ReadonlySet<string>;
}

/** Los identificadores de compañía y de negocio que mencionan estos alcances. */
export function tenantIdsOf(scopes: Iterable<AssignmentScope>): TenantIds {
  const companyIds = new Set<string>();
  const businessIds = new Set<string>();
  for (const scope of scopes) {
    if (scope.type === 'company') companyIds.add(scope.id);
    if (scope.type === 'business') businessIds.add(scope.id);
  }
  return { companyIds, businessIds };
}

export function tenantIdsOfTarget(target: TargetScope): TenantIds {
  if (target.type === 'global') return { companyIds: new Set(), businessIds: new Set() };
  return {
    companyIds: new Set([target.companyId]),
    businessIds: new Set(target.type === 'business' ? [target.businessId] : []),
  };
}

/**
 * Qué compañías y negocios, de los indicados, **no pueden conceder poder**: los inactivos, los
 * borrados (periodo de gracia), los inexistentes y los negocios de una compañía en esa situación.
 * Se devuelven las claves de alcance (`company:<id>`, `business:<id>`).
 */
export async function loadUnusable(stores: TenantStores, ids: TenantIds): Promise<Set<string>> {
  const unusable = new Set<string>();
  const businesses =
    ids.businessIds.size === 0 ? [] : await stores.businesses.getMany([...ids.businessIds]);
  const byId = new Map(businesses.map((business) => [business.id, business]));

  const companyIds = new Set(ids.companyIds);
  for (const business of businesses) companyIds.add(business.companyId);
  const companies = companyIds.size === 0 ? [] : await stores.companies.getMany([...companyIds]);
  const companyUsable = new Map(companies.map((company) => [company.id, isUsable(company)]));

  for (const companyId of companyIds) {
    if (companyUsable.get(companyId) !== true) unusable.add(companyKey(companyId));
  }
  for (const businessId of ids.businessIds) {
    const business = byId.get(businessId);
    const usable =
      business !== undefined &&
      isUsable(business) &&
      companyUsable.get(business.companyId) === true;
    if (!usable) unusable.add(businessKey(businessId));
  }
  return unusable;
}
