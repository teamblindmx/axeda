import type { AssignmentScope, TargetScope } from '../domain/scope.js';
import {
  businessKey,
  companyKey,
  isUsable,
  siteKey,
  type Business,
  type Site,
} from '../domain/tenant.js';
import type { AxedaStores } from '../ports/persistence.js';

type TenantStores = Pick<AxedaStores, 'companies' | 'businesses' | 'sites'>;

export interface TenantIds {
  readonly companyIds: ReadonlySet<string>;
  readonly businessIds: ReadonlySet<string>;
  readonly siteIds: ReadonlySet<string>;
}

/** Los identificadores de compañía, de negocio y de sede que mencionan estos alcances. */
export function tenantIdsOf(scopes: Iterable<AssignmentScope>): TenantIds {
  const companyIds = new Set<string>();
  const businessIds = new Set<string>();
  const siteIds = new Set<string>();
  for (const scope of scopes) {
    if (scope.type === 'company') companyIds.add(scope.id);
    if (scope.type === 'business') businessIds.add(scope.id);
    if (scope.type === 'site') siteIds.add(scope.id);
  }
  return { companyIds, businessIds, siteIds };
}

export function tenantIdsOfTarget(target: TargetScope): TenantIds {
  if (target.type === 'global') {
    return { companyIds: new Set(), businessIds: new Set(), siteIds: new Set() };
  }
  const businessId = target.type === 'company' ? null : target.businessId;
  return {
    companyIds: new Set([target.companyId]),
    businessIds: new Set(businessId === null ? [] : [businessId]),
    siteIds: new Set(target.type === 'site' ? [target.siteId] : []),
  };
}

/** Lo leído de la base de datos: las sedes pedidas y todo aquello de lo que cuelgan. */
interface Loaded {
  readonly sites: ReadonlyMap<string, Site>;
  readonly businesses: ReadonlyMap<string, Business>;
  /** Para cada compañía mencionada (directamente o como padre), si puede conceder poder. */
  readonly companyUsable: ReadonlyMap<string, boolean>;
  /** Los negocios mencionados, también los padres de las sedes. */
  readonly businessIds: ReadonlySet<string>;
  /** Las compañías mencionadas, también las padres de negocios y sedes. */
  readonly companyIds: ReadonlySet<string>;
}

/** Lee de abajo arriba: las sedes, después sus negocios y los pedidos, después las compañías. */
async function loadTenants(stores: TenantStores, ids: TenantIds): Promise<Loaded> {
  const sites = ids.siteIds.size === 0 ? [] : await stores.sites.getMany([...ids.siteIds]);

  const businessIds = new Set(ids.businessIds);
  for (const site of sites) if (site.businessId !== null) businessIds.add(site.businessId);
  const businesses =
    businessIds.size === 0 ? [] : await stores.businesses.getMany([...businessIds]);

  const companyIds = new Set(ids.companyIds);
  for (const parent of [...businesses, ...sites]) companyIds.add(parent.companyId);
  const companies = companyIds.size === 0 ? [] : await stores.companies.getMany([...companyIds]);

  return {
    sites: new Map(sites.map((site) => [site.id, site])),
    businesses: new Map(businesses.map((business) => [business.id, business])),
    companyUsable: new Map(companies.map((company) => [company.id, isUsable(company)])),
    businessIds,
    companyIds,
  };
}

function businessUsable(loaded: Loaded, businessId: string): boolean {
  const business = loaded.businesses.get(businessId);
  return (
    business !== undefined &&
    isUsable(business) &&
    loaded.companyUsable.get(business.companyId) === true
  );
}

function siteUsable(loaded: Loaded, siteId: string): boolean {
  const site = loaded.sites.get(siteId);
  return (
    site !== undefined &&
    isUsable(site) &&
    loaded.companyUsable.get(site.companyId) === true &&
    (site.businessId === null || businessUsable(loaded, site.businessId))
  );
}

/**
 * Qué compañías, negocios y sedes, de los indicados, **no pueden conceder poder**: los inactivos,
 * los borrados (periodo de gracia), los inexistentes y los que cuelgan de alguno en esa situación
 * (un negocio de una compañía bloqueada; una sede de un negocio o una compañía bloqueados). Se
 * devuelven las claves de alcance (`company:<id>`, `business:<id>`, `site:<id>`).
 */
export async function loadUnusable(stores: TenantStores, ids: TenantIds): Promise<Set<string>> {
  const loaded = await loadTenants(stores, ids);
  const unusable = new Set<string>();
  for (const companyId of loaded.companyIds) {
    if (loaded.companyUsable.get(companyId) !== true) unusable.add(companyKey(companyId));
  }
  for (const businessId of loaded.businessIds) {
    if (!businessUsable(loaded, businessId)) unusable.add(businessKey(businessId));
  }
  for (const siteId of ids.siteIds) {
    if (!siteUsable(loaded, siteId)) unusable.add(siteKey(siteId));
  }
  return unusable;
}
