import { covers, type PermissionKey } from '../domain/permission-key.js';
import type { Role, RoleAssignment } from '../domain/role.js';
import { assignmentApplies, type TargetScope } from '../domain/scope.js';

/** Resultado de unir los permisos de todas las funciones aplicables en un alcance. */
export class PermissionSet {
  readonly keys: readonly PermissionKey[];
  /** Alguna función aplicable exige que el usuario tenga el 2FA activado. */
  readonly requiresMfa: boolean;

  constructor(keys: Iterable<PermissionKey>, requiresMfa = false) {
    this.keys = Object.freeze([...new Set(keys)].sort());
    this.requiresMfa = requiresMfa;
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

export interface EffectivePermissionsInput {
  readonly assignments: readonly RoleAssignment[];
  readonly roles: ReadonlyMap<string, Role>;
  readonly target: TargetScope;
  readonly now: Date;
}

/**
 * Permisos efectivos de un usuario en `target`: unión de los permisos de las funciones
 * **activas**, de las asignaciones **vigentes** que **aplican** a ese alcance.
 * Función pura: no consulta nada.
 */
export function effectivePermissions(input: EffectivePermissionsInput): PermissionSet {
  const keys: PermissionKey[] = [];
  let requiresMfa = false;

  for (const assignment of input.assignments) {
    if (assignment.expiresAt !== null && assignment.expiresAt <= input.now) continue;
    if (!assignmentApplies(assignment.scope, input.target)) continue;

    const role = input.roles.get(assignment.roleId);
    if (role === undefined || role.status !== 'active') continue;

    keys.push(...role.permissions);
    requiresMfa ||= role.requireMfa;
  }
  return new PermissionSet(keys, requiresMfa);
}
