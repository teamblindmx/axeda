import type { AuditAction, AuditEvent, AuditTargetType, NewAuditEvent } from '../domain/audit.js';
import type { Page, PageRequest } from './paging.js';
import type { BusinessStore, CompanyStore, InvitationStore } from './tenants.js';
import type { PermissionKey } from '../domain/permission-key.js';
import type { Role, RoleAssignment, RoleStatus } from '../domain/role.js';
import type { AssignmentScope } from '../domain/scope.js';

export type { Page, PageRequest } from './paging.js';

export interface NewRole {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly permissions: readonly PermissionKey[];
  readonly requireMfa?: boolean | undefined;
  readonly status?: RoleStatus | undefined;
  readonly managed?: boolean | undefined;
}

export interface RoleChanges {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly permissions?: readonly PermissionKey[] | undefined;
  readonly requireMfa?: boolean | undefined;
  readonly status?: RoleStatus | undefined;
}

export interface RoleStore {
  get(id: string): Promise<Role | null>;
  getMany(ids: readonly string[]): Promise<readonly Role[]>;
  getByKey(key: string): Promise<Role | null>;
  list(page: PageRequest): Promise<Page<Role>>;
  /** Lanza `AXEDA_ROLE_KEY_TAKEN` si la clave ya existe. */
  create(input: NewRole): Promise<Role>;
  /**
   * Actualiza solo si la versión guardada es `expectedVersion` y la incrementa.
   * Lanza `AXEDA_ROLE_NOT_FOUND` o `AXEDA_VERSION_CONFLICT`.
   */
  update(id: string, expectedVersion: number, changes: RoleChanges): Promise<Role>;
  /** Devuelve `false` si no existía. Borrar una función borra sus asignaciones. */
  delete(id: string): Promise<boolean>;
}

export interface NewAssignment {
  readonly userId: string;
  readonly roleId: string;
  readonly scope: AssignmentScope;
  readonly grantedBy?: string | null | undefined;
  readonly expiresAt?: Date | null | undefined;
}

export interface AssignmentStore {
  get(id: string): Promise<RoleAssignment | null>;
  listForUser(userId: string): Promise<readonly RoleAssignment[]>;
  /** Asignaciones de exactamente ese alcance, ordenadas por id. */
  listForScope(scope: AssignmentScope, page: PageRequest): Promise<Page<RoleAssignment>>;
  countForUser(userId: string): Promise<number>;
  /** Lanza `AXEDA_ASSIGNMENT_EXISTS` si ya hay una igual (usuario, función y alcance). */
  create(input: NewAssignment): Promise<RoleAssignment>;
  /** Devuelve `false` si no existía. */
  revoke(id: string): Promise<boolean>;
  /** Para el borrado de un usuario; devuelve cuántas se eliminaron. */
  deleteForUser(userId: string): Promise<number>;
}

/**
 * Contadores que invalidan la caché de autorización.
 * Solo se incrementan de forma **atómica**: leer, sumar y escribir pierde actualizaciones.
 */
export interface AuthzStateStore {
  getUserVersion(userId: string): Promise<number>;
  bumpUserVersion(userId: string): Promise<number>;
  getPolicyVersion(): Promise<number>;
  bumpPolicyVersion(): Promise<number>;
}

export interface AuditFilter {
  readonly actorId?: string | undefined;
  readonly action?: AuditAction | undefined;
  readonly targetType?: AuditTargetType | undefined;
  readonly targetId?: string | undefined;
  /** Eventos de exactamente ese alcance. */
  readonly scope?: AssignmentScope | undefined;
}

/**
 * Registro de auditoría. Solo se añade: no hay actualizar ni borrar. Los identificadores
 * ordenan cronológicamente, así que `list` devuelve primero lo más reciente.
 */
export interface AuditStore {
  append(event: NewAuditEvent): Promise<AuditEvent>;
  list(filter: AuditFilter, page: PageRequest): Promise<Page<AuditEvent>>;
}

export interface AxedaStores {
  readonly companies: CompanyStore;
  readonly businesses: BusinessStore;
  readonly invitations: InvitationStore;
  readonly roles: RoleStore;
  readonly assignments: AssignmentStore;
  readonly authz: AuthzStateStore;
  readonly audit: AuditStore;
}

/**
 * Persistencia completa. `transaction` debe ser **atómica de verdad**: si el callback lanza,
 * no queda ninguna escritura. Axeda lo comprueba al arrancar y se niega a funcionar si no es así.
 * El callback puede ejecutarse más de una vez (p. ej. MongoDB ante errores transitorios), así que
 * dentro no puede haber efectos externos.
 */
export interface AxedaPersistence extends AxedaStores {
  transaction<T>(callback: (stores: AxedaStores) => Promise<T>): Promise<T>;
}
