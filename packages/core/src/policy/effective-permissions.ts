import { covers, type PermissionKey } from '../domain/permission-key.js';
import type { Role, RoleAssignment } from '../domain/role.js';
import { assignmentApplies, scopeKey, type TargetScope } from '../domain/scope.js';
import { businessKey, companyKey } from '../domain/tenant.js';

/** Resultado de unir los permisos de todas las funciones aplicables en un alcance. */
export class PermissionSet {
  readonly keys: readonly PermissionKey[];

  constructor(keys: Iterable<PermissionKey>) {
    this.keys = Object.freeze([...new Set(keys)].sort());
  }

  /** ¿Se concede `required`? Si nada coincide, no: se deniega por defecto. */
  allows(required: PermissionKey): boolean {
    return this.keys.some((held) => covers(held, required));
  }

  /** ¿Cubre este conjunto todos los permisos indicados? */
  allowsAll(required: readonly PermissionKey[]): boolean {
    return required.every((key) => this.allows(key));
  }

  /** Los permisos de `required` que este conjunto NO cubre. */
  missing(required: readonly PermissionKey[]): PermissionKey[] {
    return required.filter((key) => !this.allows(key));
  }
}

export const EMPTY_PERMISSIONS = new PermissionSet([]);

export interface PolicyData {
  readonly assignments: readonly RoleAssignment[];
  readonly roles: ReadonlyMap<string, Role>;
  readonly now: Date;
  /**
   * El usuario tiene el 2FA activado. Una función con `requireMfa` no concede nada si es
   * `false` o falta: ante la duda, se deniega.
   */
  readonly mfaEnabled?: boolean | undefined;
  /**
   * Claves (`scopeKey`) de compañías y negocios que no pueden conceder poder: inactivos,
   * borrados o inexistentes. Una asignación en uno de ellos no cuenta.
   */
  readonly unusable?: ReadonlySet<string> | undefined;
}

export interface EffectivePermissionsInput extends PolicyData {
  readonly target: TargetScope;
  /**
   * Si es `true`, un destino inactivo o borrado no anula los permisos: para las operaciones de
   * **administración** (un administrador global restaura una compañía borrada). Las consultas de
   * la aplicación (`can`) no lo usan: dentro de una compañía borrada no se puede hacer nada.
   */
  readonly ignoreTargetStatus?: boolean | undefined;
}

/** ¿El destino (o su compañía) está inactivo, borrado o no existe? */
function targetIsUnusable(target: TargetScope, unusable: ReadonlySet<string> | undefined): boolean {
  if (unusable === undefined || target.type === 'global') return false;
  if (unusable.has(companyKey(target.companyId))) return true;
  return target.type === 'business' && unusable.has(businessKey(target.businessId));
}

/**
 * Funciones que cuentan ahora: asignación vigente, función existente y activa, y el 2FA que
 * esa función exija. Es la única definición de "cuenta", compartida por todas las consultas.
 */
function liveRoles(data: PolicyData): Array<{ assignment: RoleAssignment; role: Role }> {
  const live: Array<{ assignment: RoleAssignment; role: Role }> = [];
  for (const assignment of data.assignments) {
    if (assignment.expiresAt !== null && assignment.expiresAt <= data.now) continue;
    if (data.unusable?.has(scopeKey(assignment.scope)) === true) continue;
    const role = data.roles.get(assignment.roleId);
    if (role === undefined || role.status !== 'active') continue;
    if (role.requireMfa && data.mfaEnabled !== true) continue;
    live.push({ assignment, role });
  }
  return live;
}

/**
 * Permisos efectivos de un usuario en `target`: unión de los permisos de las funciones
 * **activas**, de asignaciones **vigentes** que **aplican** a ese alcance.
 * Función pura: no consulta nada.
 */
export function effectivePermissions(input: EffectivePermissionsInput): PermissionSet {
  if (input.ignoreTargetStatus !== true && targetIsUnusable(input.target, input.unusable)) {
    return EMPTY_PERMISSIONS;
  }
  const keys: PermissionKey[] = [];
  for (const { assignment, role } of liveRoles(input)) {
    if (assignmentApplies(assignment.scope, input.target)) keys.push(...role.permissions);
  }
  return new PermissionSet(keys);
}

/**
 * Permisos que el usuario tiene en **algún** alcance, sin importar cuál. Sirve para decidir si
 * puede ver listados de administración (cada operación vuelve a comprobar su alcance concreto).
 */
export function permissionsHeldAnywhere(data: PolicyData): PermissionSet {
  return new PermissionSet(liveRoles(data).flatMap(({ role }) => role.permissions));
}

/** Alcances de asignación donde el usuario tiene `permission` (por herencia, los de abajo no se listan). */
export function scopesGranting(
  data: PolicyData,
  permission: PermissionKey,
): RoleAssignment['scope'][] {
  const scopes = new Map<string, RoleAssignment['scope']>();
  for (const { assignment, role } of liveRoles(data)) {
    if (role.permissions.some((held) => covers(held, permission))) {
      const { scope } = assignment;
      scopes.set(scope.type === 'global' ? 'global' : `${scope.type}:${scope.id}`, scope);
    }
  }
  return [...scopes.values()];
}

/** Los alcances de todas las asignaciones que cuentan ahora (con cualquier permiso). */
export function liveAssignmentScopes(data: PolicyData): RoleAssignment['scope'][] {
  return liveRoles(data).map(({ assignment }) => assignment.scope);
}
