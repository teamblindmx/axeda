import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import { WILDCARD, type PermissionKey } from '../domain/permission-key.js';
import type { PermissionSet } from './effective-permissions.js';

export type UserActionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'missing_user_permission' | 'target_has_more_power';
      readonly permissions: readonly PermissionKey[];
    };

/**
 * El poder **administrativo** de un conjunto de permisos: el total (`*`) y los propios de Axeda
 * (`axeda:…`, con o sin comodín). Los permisos de la aplicación (`invoice:read`) no cuentan: que
 * el soporte pueda bloquear a un cajero no es una escalada.
 */
export const administrativePower = (held: PermissionSet): PermissionKey[] =>
  held.keys.filter((key) => key === WILDCARD || key.startsWith('axeda:'));

/**
 * ¿Puede `actor` bloquear, desbloquear o cerrar las sesiones de alguien con los permisos `target`?
 *
 * Exige `axeda:user:manage` en global y que el poder administrativo del objetivo esté cubierto por
 * el de quien actúa: sin esta regla, quien solo gestiona usuarios podría bloquear al administrador
 * global (y dejar la plataforma sin nadie) o a cualquiera con más poder que él.
 */
export function authorizeUserAction(input: {
  /** Permisos de quien actúa en el alcance global. */
  readonly actor: PermissionSet;
  /** Permisos que el objetivo tiene en cualquier alcance. */
  readonly target: PermissionSet;
}): UserActionDecision {
  const { actor, target } = input;
  if (!actor.allows(AXEDA_PERMISSIONS.userManage)) {
    return { allowed: false, reason: 'missing_user_permission', permissions: [] };
  }
  const missing = actor.missing(administrativePower(target));
  if (missing.length > 0) {
    return { allowed: false, reason: 'target_has_more_power', permissions: missing };
  }
  return { allowed: true };
}
