import type { Role, RoleAssignment } from '../domain/role.js';

/** Lo que se necesita para decidir los permisos de un usuario en cualquier alcance. */
export interface AuthzSnapshot {
  readonly assignments: readonly RoleAssignment[];
  readonly roles: ReadonlyMap<string, Role>;
  /** Compañías y negocios de sus asignaciones que no pueden conceder poder (`scopeKey`). */
  readonly unusable: ReadonlySet<string>;
}

interface Entry {
  readonly authzVersion: number;
  readonly policyVersion: number;
  readonly snapshot: AuthzSnapshot;
}

/**
 * Caché en memoria de permisos, **validada por versión**.
 *
 * Una entrada solo se usa si sus dos contadores coinciden con los actuales; si no, es como si
 * no existiera. Por eso no necesita caducar ni invalidarse de forma activa: la seguridad no
 * depende de ella, solo el rendimiento. Es de tamaño acotado (LRU) para no crecer sin límite.
 */
export class AuthzCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;

  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  get(userId: string, authzVersion: number, policyVersion: number): AuthzSnapshot | undefined {
    const entry = this.#entries.get(userId);
    if (entry === undefined) return undefined;
    if (entry.authzVersion !== authzVersion || entry.policyVersion !== policyVersion) {
      this.#entries.delete(userId);
      return undefined;
    }
    // Se marca como usada recientemente.
    this.#entries.delete(userId);
    this.#entries.set(userId, entry);
    return entry.snapshot;
  }

  set(userId: string, authzVersion: number, policyVersion: number, snapshot: AuthzSnapshot): void {
    this.#entries.delete(userId);
    this.#entries.set(userId, { authzVersion, policyVersion, snapshot });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
