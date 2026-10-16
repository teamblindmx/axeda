import type { Principal, Role } from '../domain/role.js';
import { AxedaError } from '../errors.js';
import type { AxedaStores } from '../ports/persistence.js';
import type { AuthzCache, AuthzSnapshot } from './authz-cache.js';

export function assertPrincipal(principal: Principal): void {
  if (typeof principal?.userId !== 'string' || principal.userId.length === 0) {
    throw new AxedaError('AXEDA_INVALID_CONFIG', 'The principal must have a non-empty userId.');
  }
}

/** Lee las asignaciones de un usuario y las funciones que usan, directamente de los almacenes. */
export async function loadSnapshot(stores: AxedaStores, userId: string): Promise<AuthzSnapshot> {
  const assignments = await stores.assignments.listForUser(userId);
  const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))];
  const roles = new Map<string, Role>(
    (await stores.roles.getMany(roleIds)).map((role) => [role.id, role]),
  );
  return { assignments, roles };
}

/**
 * Lector de permisos para las **consultas** (`can`, `scopesFor`…): usa la caché validada por
 * versión. Las operaciones de administración NO lo usan: leen siempre con `loadSnapshot`
 * dentro de su transacción, porque decidir una concesión con datos cacheados sería una carrera.
 */
export class AuthzReader {
  readonly #stores: AxedaStores;
  readonly #cache: AuthzCache;

  constructor(stores: AxedaStores, cache: AuthzCache) {
    this.#stores = stores;
    this.#cache = cache;
  }

  async snapshotFor(principal: Principal): Promise<AuthzSnapshot> {
    assertPrincipal(principal);
    const { userId } = principal;
    // ORDEN IMPORTANTE: primero las versiones, después los datos. Si algo cambia entre las dos
    // lecturas, los datos serán más nuevos que la etiqueta y la próxima consulta los recargará.
    // Al revés, datos viejos con una etiqueta nueva se servirían para siempre.
    const authzVersion =
      principal.authzVersion ?? (await this.#stores.authz.getUserVersion(userId));
    const policyVersion = await this.#stores.authz.getPolicyVersion();

    const cached = this.#cache.get(userId, authzVersion, policyVersion);
    if (cached !== undefined) return cached;

    const snapshot = await loadSnapshot(this.#stores, userId);
    this.#cache.set(userId, authzVersion, policyVersion, snapshot);
    return snapshot;
  }
}
