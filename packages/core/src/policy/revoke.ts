import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { PermissionKey } from '../domain/permission-key.js';
import type { Role } from '../domain/role.js';
import type { PermissionSet } from './effective-permissions.js';

export type RevokeDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'missing_assignment_permission' | 'exceeds_granter_permissions';
      readonly permissions: readonly PermissionKey[];
    };

/**
 * ¿Puede quien revoca quitar una asignación de `role` en su alcance?
 *
 * Exige `axeda:assignment:manage` en el alcance de la asignación y, igual que al asignar, que
 * sus permisos cubran los de la función: así un administrador menor no puede quitarle el acceso
 * a uno mayor. A diferencia de asignar, se puede revocar una función desactivada.
 */
export function authorizeRevoke(input: {
  /** Permisos efectivos de quien revoca, calculados **en el alcance de la asignación**. */
  readonly granter: PermissionSet;
  readonly role: Role;
}): RevokeDecision {
  const { granter, role } = input;
  if (!granter.allows(AXEDA_PERMISSIONS.assignmentManage)) {
    return { allowed: false, reason: 'missing_assignment_permission', permissions: [] };
  }
  const missing = granter.missing(role.permissions);
  if (missing.length > 0) {
    return { allowed: false, reason: 'exceeds_granter_permissions', permissions: missing };
  }
  return { allowed: true };
}
