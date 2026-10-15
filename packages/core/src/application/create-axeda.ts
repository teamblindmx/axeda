import { resolveOptions, type AxedaOptions, type ResolvedOptions } from '../config/options.js';
import { isWildcard, parsePermissionKey, type PermissionKey } from '../domain/permission-key.js';
import type { Principal, Role } from '../domain/role.js';
import { GLOBAL_TARGET, type TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import { effectivePermissions, type PermissionSet } from '../policy/effective-permissions.js';
import type { AxedaPersistence } from '../ports/persistence.js';
import { systemClock, type Clock } from '../ports/platform.js';
import { assertTransactional } from './startup-checks.js';

export interface AxedaDependencies {
  readonly persistence: AxedaPersistence;
  readonly clock?: Clock;
}

export interface Axeda {
  /** Permisos de la aplicación más los propios de Axeda. */
  readonly catalog: readonly PermissionKey[];
  readonly options: ResolvedOptions;
  /**
   * Comprueba la persistencia (transacciones reales). Es idempotente; si falla, el error se
   * memoriza y ninguna operación posterior funciona con una persistencia sin verificar.
   * Se recomienda esperarlo al arrancar; las demás operaciones también lo esperan.
   */
  start(): Promise<void>;
  /** Permisos efectivos del usuario en `target` (global por defecto). */
  effectivePermissions(principal: Principal, target?: TargetScope): Promise<PermissionSet>;
  /** ¿Puede el usuario ejercer `permission` en `target`? Se deniega por defecto. */
  can(principal: Principal, permission: string, target?: TargetScope): Promise<boolean>;
}

function assertPrincipal(principal: Principal): void {
  if (typeof principal?.userId !== 'string' || principal.userId.length === 0) {
    throw new AxedaError('AXEDA_INVALID_CONFIG', 'The principal must have a non-empty userId.');
  }
}

/** Se pide un permiso concreto y conocido: un error tipográfico es un error, no un "no". */
function requirePermission(catalog: ReadonlySet<PermissionKey>, permission: string): PermissionKey {
  const key = parsePermissionKey(permission);
  if (isWildcard(key)) {
    throw new AxedaError(
      'AXEDA_INVALID_PERMISSION',
      `"${permission}" is a wildcard; a check needs a concrete permission.`,
    );
  }
  if (!catalog.has(key)) {
    throw new AxedaError(
      'AXEDA_UNKNOWN_PERMISSION',
      `"${permission}" is not in the permission catalog. Declare it in createAxeda({ permissions }).`,
    );
  }
  return key;
}

export function createAxeda(options: AxedaOptions, dependencies: AxedaDependencies): Axeda {
  const resolved = resolveOptions(options);
  const { persistence } = dependencies;
  const clock = dependencies.clock ?? systemClock;
  const catalogSet: ReadonlySet<PermissionKey> = new Set(resolved.catalog);

  let started: Promise<void> | undefined;
  const start = (): Promise<void> => (started ??= assertTransactional(persistence));

  async function loadEffectivePermissions(
    principal: Principal,
    target: TargetScope,
  ): Promise<PermissionSet> {
    assertPrincipal(principal);
    await start();
    const assignments = await persistence.assignments.listForUser(principal.userId);
    const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))];
    const roles = new Map<string, Role>(
      (await persistence.roles.getMany(roleIds)).map((role) => [role.id, role]),
    );
    return effectivePermissions({ assignments, roles, target, now: clock.now() });
  }

  return {
    catalog: resolved.catalog,
    options: resolved,
    start,
    effectivePermissions: (principal, target = GLOBAL_TARGET) =>
      loadEffectivePermissions(principal, target),
    async can(principal, permission, target = GLOBAL_TARGET) {
      const key = requirePermission(catalogSet, permission);
      return (await loadEffectivePermissions(principal, target)).allows(key);
    },
  };
}
