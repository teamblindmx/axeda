import type { StaffAccount, StoredStaffAccount } from '../domain/staff.js';
import type { Page, PageRequest } from './paging.js';

/**
 * Hash del PIN. Tiene que ser lento y llevar una clave del servidor (_pepper_): un PIN de 6 dígitos
 * tiene un millón de combinaciones, y sin esa clave una copia de la base de datos bastaría para
 * probarlas todas. Con Better Auth lo pone el plugin.
 */
export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(pin: string, hash: string): Promise<boolean>;
}

export interface NewStaffAccount {
  readonly userId: string;
  readonly companyId: string;
  readonly businessId: string | null;
  readonly siteId: string | null;
  /** Ya normalizado. */
  readonly username: string;
  readonly pinHash: string;
  readonly createdBy: string;
}

export interface StaffFilter {
  readonly companyId: string;
  /**
   * Solo las cuentas de ese negocio (las suyas y las de sus sedes). Sin él, todas las de la
   * compañía.
   */
  readonly businessId?: string | undefined;
  /** Solo las de esa sede. */
  readonly siteId?: string | undefined;
}

export interface AttemptPolicy {
  /** Intentos permitidos antes de bloquear. */
  readonly maxAttempts: number;
  /** Cuánto dura el primer bloqueo. Cada bloqueo seguido dura el doble que el anterior. */
  readonly lockMs: number;
  /** Lo más que puede durar un bloqueo. */
  readonly maxLockMs: number;
}

/** Duración del bloqueo número `lockCount + 1`: `lockMs`, el doble, el doble… hasta `maxLockMs`. */
export function lockDuration(policy: AttemptPolicy, lockCount: number): number {
  return Math.min(policy.maxLockMs, policy.lockMs * 2 ** Math.min(lockCount, 30));
}

/** De quién son las cuentas que se purgan con su compañía, negocio o sede. */
export interface StaffOwners {
  readonly companyIds: readonly string[];
  readonly businessIds: readonly string[];
  readonly siteIds: readonly string[];
}

export interface StaffStore {
  get(userId: string): Promise<StoredStaffAccount | null>;
  /** El usuario ya normalizado. */
  findByUsername(companyId: string, username: string): Promise<StoredStaffAccount | null>;
  /** Lanza `AXEDA_USERNAME_TAKEN` si el usuario ya existe en esa compañía. */
  create(input: NewStaffAccount): Promise<StaffAccount>;
  /** Ordenadas por usuario. */
  list(filter: StaffFilter, page: PageRequest): Promise<Page<StaffAccount>>;
  /** Lanza `AXEDA_USERNAME_TAKEN` o `AXEDA_STAFF_NOT_FOUND`. */
  rename(userId: string, username: string): Promise<StaffAccount>;
  /** Nuevo PIN: también reinicia los intentos y los bloqueos, y quita el bloqueo. */
  setPin(userId: string, pinHash: string, at: Date): Promise<void>;
  /**
   * Gasta un intento **antes** de comprobar el PIN, de forma atómica: de varios intentos
   * simultáneos solo pasan los que quedan. Devuelve `'locked'` si no queda ninguno. Al gastar el
   * último bloquea la cuenta `lockDuration(policy, lockCount)` y suma un bloqueo seguido. Un
   * bloqueo vencido se levanta solo y devuelve los intentos, pero no borra los bloqueos seguidos.
   */
  consumeAttempt(userId: string, now: Date, policy: AttemptPolicy): Promise<'allowed' | 'locked'>;
  /** Tras un acierto o un desbloqueo: intentos y bloqueos seguidos a cero, y sin bloqueo. */
  resetAttempts(userId: string): Promise<void>;
  /** Devuelve `false` si no existía. */
  delete(userId: string): Promise<boolean>;
  /**
   * Borra las cuentas de esas compañías (con todo lo suyo), negocios (con sus sedes) y sedes, y
   * las devuelve para borrar también sus usuarios.
   */
  deleteOwnedBy(owners: StaffOwners): Promise<readonly StaffAccount[]>;
}
