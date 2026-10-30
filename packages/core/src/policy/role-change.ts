import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { PermissionKey } from '../domain/permission-key.js';
import type { PermissionSet } from './effective-permissions.js';

export type RoleChangeDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'missing_role_permission' | 'exceeds_actor_permissions';
      readonly permissions: readonly PermissionKey[];
    };

/**
 * ¿Puede quien edita funciones **añadir** `added` a una función?
 *
 * Editar una función cambia lo que pueden hacer todos sus titulares, incluido quien edita. Sin
 * esta regla, un gestor de funciones podría añadir `*` a su propia función y escalar. Por eso
 * lo que se añade debe estar cubierto por los permisos **globales** de quien edita (una función
 * es global y puede asignarse en cualquier alcance). Quitar permisos solo exige gestionar funciones.
 */
export function authorizeRoleChange(input: {
  /** Permisos efectivos de quien edita en el alcance global. */
  readonly actor: PermissionSet;
  /** Permisos que la función no tenía y pasa a tener (todos, si se crea). */
  readonly added: readonly PermissionKey[];
}): RoleChangeDecision {
  const { actor, added } = input;
  if (!actor.allows(AXEDA_PERMISSIONS.roleManage)) {
    return { allowed: false, reason: 'missing_role_permission', permissions: [] };
  }
  const missing = actor.missing(added);
  if (missing.length > 0) {
    return { allowed: false, reason: 'exceeds_actor_permissions', permissions: missing };
  }
  return { allowed: true };
}
