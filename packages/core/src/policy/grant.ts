import { AXEDA_PERMISSION_SCOPES, AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import { covers, parsePermissionKey, type PermissionKey } from '../domain/permission-key.js';
import type { Role } from '../domain/role.js';
import type { ScopeType } from '../domain/scope.js';
import type { PermissionSet } from './effective-permissions.js';

export type GrantDenialReason =
  | 'role_inactive'
  | 'missing_assignment_permission'
  | 'permission_not_valid_in_scope'
  | 'exceeds_granter_permissions';

export type GrantDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: GrantDenialReason;
      /** Permisos que provocan la denegación, cuando aplica. */
      readonly permissions: readonly PermissionKey[];
    };

export interface GrantInput {
  /** Permisos efectivos de quien concede, calculados **en el alcance de destino**. */
  readonly granter: PermissionSet;
  readonly role: Role;
  readonly scopeType: ScopeType;
}

const deny = (
  reason: GrantDenialReason,
  permissions: readonly PermissionKey[] = [],
): GrantDecision => ({ allowed: false, reason, permissions });

/** Permisos propios de Axeda que la función concede (incluso por comodín) y que no valen en `scopeType`. */
function axedaPermissionsOutOfScope(role: Role, scopeType: ScopeType): PermissionKey[] {
  return Object.entries(AXEDA_PERMISSION_SCOPES)
    .filter(([, allowedScopes]) => !allowedScopes.includes(scopeType))
    .map(([axedaKey]) => parsePermissionKey(axedaKey))
    .filter((axedaKey) => role.permissions.some((held) => covers(held, axedaKey)));
}

/**
 * ¿Puede quien concede asignar `role` en un alcance de tipo `scopeType` (ADR-0003)?
 *
 * 1. La función debe estar activa.
 * 2. Debe tener `axeda:assignment:manage` en el alcance de destino. Como sus permisos se
 *    calculan *en ese alcance*, un admin de compañía no puede asignar en global ni en otra compañía.
 * 3. La función no puede conceder permisos propios de Axeda fuera de los alcances donde son
 *    válidos (esto restringe a global el comodín total `*`).
 * 4. Sin escalada: todos los permisos de la función deben estar cubiertos por los suyos.
 */
export function authorizeGrant(input: GrantInput): GrantDecision {
  const { granter, role, scopeType } = input;

  if (role.status !== 'active') return deny('role_inactive');
  if (!granter.allows(AXEDA_PERMISSIONS.assignmentManage)) {
    return deny('missing_assignment_permission');
  }

  const outOfScope = axedaPermissionsOutOfScope(role, scopeType);
  if (outOfScope.length > 0) return deny('permission_not_valid_in_scope', outOfScope);

  const missing = granter.missing(role.permissions);
  if (missing.length > 0) return deny('exceeds_granter_permissions', missing);

  return { allowed: true };
}
