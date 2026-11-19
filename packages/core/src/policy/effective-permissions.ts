import { covers, type PermissionKey } from '../domain/permission-key.js';
import type { Role, RoleAssignment } from '../domain/role.js';
import { assignmentApplies, scopeKey, type TargetScope } from '../domain/scope.js';
import { businessKey, companyKey, siteKey } from '../domain/tenant.js';

/**
 * Un permiso concedido y lo que no cubre: los permisos de las funcionalidades que la compañía de esa
 * asignación no tiene. Un `*` en una compañía sin inventario vale para todo menos `inventory:*`.
 */
export interface Grant {
  readonly key: PermissionKey;
  readonly except: readonly PermissionKey[];
}

const NO_EXCEPTIONS: readonly PermissionKey[] = Object.freeze([]);

/** Resultado de unir los permisos de todas las funciones aplicables en un alcance. */
export class PermissionSet {
  /** Los permisos concedidos (algunos pueden tener excepciones: para saber, `allows`). */
  readonly keys: readonly PermissionKey[];
  readonly #grants: readonly Grant[];

  constructor(grants: Iterable<PermissionKey | Grant>) {
    const list = [...grants].map((grant) =>
      typeof grant === 'string' ? { key: grant, except: NO_EXCEPTIONS } : grant,
    );
    // Un permiso concedido sin excepciones hace innecesarias las copias con excepciones.
    const free = new Set(list.filter((grant) => grant.except.length === 0).map((g) => g.key));
    this.#grants = Object.freeze(
      list.filter((grant) => grant.except.length === 0 || !free.has(grant.key)),
    );
    this.keys = Object.freeze([...new Set(list.map((grant) => grant.key))].sort());
  }

  /** ¿Se concede `required`? Si nada coincide, no: se deniega por defecto. */
  allows(required: PermissionKey): boolean {
    return this.#grants.some(
      (grant) =>
        covers(grant.key, required) && !grant.except.some((blocked) => covers(blocked, required)),
    );
  }

  /** Los permisos del catálogo que de verdad se conceden, sin comodines y ordenados (para un frontend). */
  concrete(catalog: readonly PermissionKey[]): PermissionKey[] {
    return catalog.filter((key) => this.allows(key)).sort();
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
  /** El usuario está bloqueado: no cuenta ninguna asignación. */
  readonly banned?: boolean | undefined;
  /**
   * Claves (`scopeKey`) de compañías, negocios y sedes que no pueden conceder poder: inactivos,
   * borrados o inexistentes. Una asignación en uno de ellos no cuenta.
   */
  readonly unusable?: ReadonlySet<string> | undefined;
  /**
   * Por alcance de asignación (`scopeKey`): los permisos de las funcionalidades que su compañía no
   * tiene. No cuentan para esa asignación. Las globales nunca se recortan.
   */
  readonly gated?: ReadonlyMap<string, readonly PermissionKey[]> | undefined;
}

/** Lo que no cubre una asignación por las funcionalidades de su compañía. */
const gatedFor = (data: PolicyData, assignment: RoleAssignment): readonly PermissionKey[] =>
  data.gated?.get(scopeKey(assignment.scope)) ?? NO_EXCEPTIONS;

const grantsOf = (data: PolicyData, assignment: RoleAssignment, role: Role): Grant[] => {
  const except = gatedFor(data, assignment);
  return role.permissions.map((key) => ({ key, except }));
};

export interface EffectivePermissionsInput extends PolicyData {
  readonly target: TargetScope;
  /**
   * Si es `true`, un destino inactivo o borrado no anula los permisos: para las operaciones de
   * **administración** (un administrador global restaura una compañía borrada). Las consultas de
   * la aplicación (`can`) no lo usan: dentro de una compañía borrada no se puede hacer nada.
   */
  readonly ignoreTargetStatus?: boolean | undefined;
}

/** ¿El destino (o su compañía, o el negocio de una sede) está inactivo, borrado o no existe? */
function targetIsUnusable(target: TargetScope, unusable: ReadonlySet<string> | undefined): boolean {
  if (unusable === undefined || target.type === 'global') return false;
  if (unusable.has(companyKey(target.companyId))) return true;
  if (target.type === 'company') return false;
  if (target.businessId !== null && unusable.has(businessKey(target.businessId))) return true;
  return target.type === 'site' && unusable.has(siteKey(target.siteId));
}

/**
 * Funciones que cuentan ahora: asignación vigente, función existente y activa, y el 2FA que
 * esa función exija. Es la única definición de "cuenta", compartida por todas las consultas.
 */
function liveRoles(data: PolicyData): Array<{ assignment: RoleAssignment; role: Role }> {
  const live: Array<{ assignment: RoleAssignment; role: Role }> = [];
  if (data.banned === true) return live;
  for (const assignment of data.assignments) {
    if (!assignmentIsLive(assignment, data)) continue;
    const role = data.roles.get(assignment.roleId);
    if (role === undefined || role.status !== 'active') continue;
    if (role.requireMfa && data.mfaEnabled !== true) continue;
    live.push({ assignment, role });
  }
  return live;
}

/** La asignación no ha caducado y su compañía o negocio puede conceder poder. */
function assignmentIsLive(assignment: RoleAssignment, data: PolicyData): boolean {
  if (assignment.expiresAt !== null && assignment.expiresAt <= data.now) return false;
  return data.unusable?.has(scopeKey(assignment.scope)) !== true;
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
  const grants: Grant[] = [];
  for (const { assignment, role } of liveRoles(input)) {
    if (assignmentApplies(assignment.scope, input.target)) {
      grants.push(...grantsOf(input, assignment, role));
    }
  }
  return new PermissionSet(grants);
}

/**
 * Permisos que el usuario tiene en **algún** alcance, sin importar cuál. Sirve para decidir si
 * puede ver listados de administración (cada operación vuelve a comprobar su alcance concreto).
 */
export function permissionsHeldAnywhere(data: PolicyData): PermissionSet {
  return new PermissionSet(
    liveRoles(data).flatMap(({ assignment, role }) => grantsOf(data, assignment, role)),
  );
}

/** Alcances de asignación donde el usuario tiene `permission` (por herencia, los de abajo no se listan). */
export function scopesGranting(
  data: PolicyData,
  permission: PermissionKey,
): RoleAssignment['scope'][] {
  const scopes = new Map<string, RoleAssignment['scope']>();
  for (const { assignment, role } of liveRoles(data)) {
    const blocked = gatedFor(data, assignment).some((gated) => covers(gated, permission));
    if (!blocked && role.permissions.some((held) => covers(held, permission))) {
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
