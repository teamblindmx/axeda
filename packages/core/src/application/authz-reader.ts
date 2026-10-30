import type { Principal, Role } from '../domain/role.js';
import type { TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { AxedaStores } from '../ports/persistence.js';
import type { AuthzCache, AuthzSnapshot } from './authz-cache.js';
import { loadUnusable, tenantIdsOf, tenantIdsOfTarget } from './tenant-status.js';

export function assertPrincipal(principal: Principal): void {
  if (typeof principal?.userId !== 'string' || principal.userId.length === 0) {
    throw new AxedaError('AXEDA_INVALID_CONFIG', 'The principal must have a non-empty userId.');
  }
}

/**
 * Lee las asignaciones de un usuario, las funciones que usan y qué compañías y negocios de sus
 * asignaciones no pueden conceder poder, directamente de los almacenes.
 */
export async function loadSnapshot(stores: AxedaStores, userId: string): Promise<AuthzSnapshot> {
  const assignments = await stores.assignments.listForUser(userId);
  const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))];
  const roles = new Map<string, Role>(
    (await stores.roles.getMany(roleIds)).map((role) => [role.id, role]),
  );
  const unusable = await loadUnusable(
    stores,
    tenantIdsOf(assignments.map((assignment) => assignment.scope)),
  );
  return { assignments, roles, unusable };
}

export interface Read {
  readonly snapshot: AuthzSnapshot;
  /** La versión de política con la que se leyó; etiqueta cualquier dato derivado. */
  readonly policyVersion: number;
}

const MAX_TARGETS = 10_000;

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

  constructor(stores: AxedaStores, cache: AuthzCache) {
    this.#stores = stores;
    this.#cache = cache;
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

    const snapshot = await loadSnapshot(this.#stores, userId);
    this.#cache.set(userId, authzVersion, policyVersion, snapshot);
    return { snapshot, policyVersion };
  }

  /** Qué parte del destino (compañía, negocio) no puede conceder poder, con caché por versión. */
  async unusableForTarget(
    policyVersion: number,
    target: TargetScope,
  ): Promise<ReadonlySet<string>> {
    if (target.type === 'global') return new Set();
    if (this.#targetsVersion !== policyVersion || this.#targets.size >= MAX_TARGETS) {
      this.#targets.clear();
      this.#targetsVersion = policyVersion;
    }
    const key =
      target.type === 'company' ? target.companyId : `${target.companyId}/${target.businessId}`;
    const cacheKey = `${target.type}:${key}`;
    const known = this.#targets.get(cacheKey);
    if (known !== undefined) return known;
    const loaded = await loadUnusable(this.#stores, tenantIdsOfTarget(target));
    this.#targets.set(cacheKey, loaded);
    return loaded;
  }
}
