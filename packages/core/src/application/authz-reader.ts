import type { Principal, Role } from '../domain/role.js';
import { administrativePermissions } from '../policy/grant.js';
import type { TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { AxedaStores } from '../ports/persistence.js';
import type { AuthzCache, AuthzSnapshot } from './authz-cache.js';
import {
  loadTenantContext,
  loadUnusable,
  tenantIdsOf,
  tenantIdsOfTarget,
} from './tenant-status.js';
import type { ResolvedFeature } from '../config/features.js';
import type { PermissionKey } from '../domain/permission-key.js';

const NOTHING_GATED: ReadonlyMap<string, readonly PermissionKey[]> = new Map();

/**
 * Para cada alcance de asignación, los permisos de las funcionalidades que su compañía no tiene
 * (encendidas o no según la plataforma, o su valor por omisión). Sin funcionalidades declaradas no
 * consulta nada.
 */
async function gatedScopes(
  stores: AxedaStores,
  features: ReadonlyMap<string, ResolvedFeature> | undefined,
  companyOf: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, readonly PermissionKey[]>> {
  const companyIds = [...new Set(companyOf.values())];
  if (features === undefined || features.size === 0 || companyIds.length === 0) {
    return NOTHING_GATED;
  }
  const states = await stores.features.listForCompanies(companyIds);
  const enabled = (companyId: string, feature: ResolvedFeature) =>
    states.find((state) => state.companyId === companyId && state.feature === feature.key)
      ?.enabled ?? feature.enabledByDefault;
  const blocked = new Map(
    companyIds.map((companyId) => [
      companyId,
      [...features.values()]
        .filter((feature) => !enabled(companyId, feature))
        .flatMap((feature) => feature.permissions),
    ]),
  );
  const gated = new Map<string, readonly PermissionKey[]>();
  for (const [scope, companyId] of companyOf) {
    const permissions = blocked.get(companyId) ?? [];
    if (permissions.length > 0) gated.set(scope, permissions);
  }
  return gated;
}

export function assertPrincipal(principal: Principal): void {
  if (typeof principal?.userId !== 'string' || principal.userId.length === 0) {
    throw new AxedaError('AXEDA_INVALID_CONFIG', 'The principal must have a non-empty userId.');
  }
}

/**
 * Lee las asignaciones de un usuario, las funciones que usan y qué compañías y negocios de sus
 * asignaciones no pueden conceder poder, directamente de los almacenes.
 */
export async function loadSnapshot(
  stores: AxedaStores,
  userId: string,
  features?: ReadonlyMap<string, ResolvedFeature>,
): Promise<AuthzSnapshot> {
  // En paralelo: saber si es personal no añade espera, solo una consulta en la carga en frío.
  const [assignments, staff] = await Promise.all([
    stores.assignments.listForUser(userId),
    stores.staff.get(userId),
  ]);
  const pinAccount = staff !== null;
  const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))];
  const roles = new Map<string, Role>(
    (await stores.roles.getMany(roleIds)).map((role) => [
      role.id,
      pinAccount ? withoutAdministration(role) : role,
    ]),
  );
  const { unusable, companyOf } = await loadTenantContext(
    stores,
    tenantIdsOf(assignments.map((assignment) => assignment.scope)),
  );
  const gated = await gatedScopes(stores, features, companyOf);
  return { assignments, roles, unusable, pinAccount, gated };
}

/**
 * La función tal como la vive una cuenta de personal: sin ningún permiso que cubra uno de Axeda.
 * Así, aunque alguien edite después una función que ya tiene asignada, no gana poder de
 * administración (un `*` no le da nada; un `invoice:*` sigue valiendo).
 */
function withoutAdministration(role: Role): Role {
  const administrative = new Set(administrativePermissions(role.permissions));
  return administrative.size === 0
    ? role
    : { ...role, permissions: role.permissions.filter((key) => !administrative.has(key)) };
}

export interface Read {
  readonly snapshot: AuthzSnapshot;
  /** La versión de política con la que se leyó; etiqueta cualquier dato derivado. */
  readonly policyVersion: number;
}

const MAX_TARGETS = 10_000;

/** Ruta única de un destino que no es global: compañía, negocio y sede, separados por `/`. */
function targetPath(target: Exclude<TargetScope, { type: 'global' }>): string {
  switch (target.type) {
    case 'company':
      return target.companyId;
    case 'business':
      return `${target.companyId}/${target.businessId}`;
    case 'site':
      return `${target.companyId}/${target.businessId ?? '-'}/${target.siteId}`;
  }
}

/**
 * Lector de permisos para las **consultas** (`can`, `scopesFor`…): usa la caché validada por
 * versión. Las operaciones de administración NO lo usan: leen siempre con `loadSnapshot`
 * dentro de su transacción, porque decidir una concesión con datos cacheados sería una carrera.
 *
 * El estado de las compañías y negocios también se cachea, con la versión de política como
 * etiqueta: cambiar el estado de una compañía o negocio sube esa versión en la misma transacción.
 */
export class AuthzReader {
  readonly #stores: AxedaStores;
  readonly #cache: AuthzCache;
  #targetsVersion = -1;
  readonly #targets = new Map<string, ReadonlySet<string>>();

  readonly #features: ReadonlyMap<string, ResolvedFeature> | undefined;

  constructor(
    stores: AxedaStores,
    cache: AuthzCache,
    features?: ReadonlyMap<string, ResolvedFeature>,
  ) {
    this.#stores = stores;
    this.#cache = cache;
    this.#features = features;
  }

  async read(principal: Principal): Promise<Read> {
    assertPrincipal(principal);
    const { userId } = principal;
    // ORDEN IMPORTANTE: primero las versiones, después los datos. Si algo cambia entre las dos
    // lecturas, los datos serán más nuevos que la etiqueta y la próxima consulta los recargará.
    // Al revés, datos viejos con una etiqueta nueva se servirían para siempre.
    const authzVersion =
      principal.authzVersion ?? (await this.#stores.authz.getUserVersion(userId));
    const policyVersion = await this.#stores.authz.getPolicyVersion();

    const cached = this.#cache.get(userId, authzVersion, policyVersion);
    if (cached !== undefined) return { snapshot: cached, policyVersion };

    const snapshot = await loadSnapshot(this.#stores, userId, this.#features);
    this.#cache.set(userId, authzVersion, policyVersion, snapshot);
    return { snapshot, policyVersion };
  }

  /** Qué parte del destino (compañía, negocio, sede) no puede conceder poder, con caché por versión. */
  async unusableForTarget(
    policyVersion: number,
    target: TargetScope,
  ): Promise<ReadonlySet<string>> {
    if (target.type === 'global') return new Set();
    if (this.#targetsVersion !== policyVersion || this.#targets.size >= MAX_TARGETS) {
      this.#targets.clear();
      this.#targetsVersion = policyVersion;
    }
    const cacheKey = `${target.type}:${targetPath(target)}`;
    const known = this.#targets.get(cacheKey);
    if (known !== undefined) return known;
    const loaded = await loadUnusable(this.#stores, tenantIdsOfTarget(target));
    this.#targets.set(cacheKey, loaded);
    return loaded;
  }
}
