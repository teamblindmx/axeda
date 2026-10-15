import type { ResolvedOptions } from '../config/options.js';
import type { PermissionKey } from '../domain/permission-key.js';
import type { Principal } from '../domain/role.js';
import type { AssignmentScope, TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import { effectivePermissions, type PermissionSet } from '../policy/effective-permissions.js';
import type { ScopeResolver, UserDirectory } from '../ports/identity.js';
import type { AxedaPersistence, AxedaStores } from '../ports/persistence.js';
import type { Clock } from '../ports/platform.js';
import { assertPrincipal, loadSnapshot } from './authz-reader.js';

/** Clave reservada de la función total que crea `bootstrap`. */
export const SUPER_ADMIN_ROLE_KEY = 'super-admin';

/** Dependencias compartidas por los casos de uso. */
export interface Services {
  readonly persistence: AxedaPersistence;
  readonly clock: Clock;
  readonly options: ResolvedOptions;
  readonly catalog: ReadonlySet<PermissionKey>;
  readonly users: UserDirectory;
  readonly scopes: ScopeResolver | undefined;
  /** Espera a que el arranque (transacciones, funciones declaradas) haya terminado bien. */
  readonly ready: () => Promise<void>;
}

export const invalidInput = (message: string): AxedaError =>
  new AxedaError('AXEDA_INVALID_INPUT', message);

/** Ejecuta `parse` y convierte los errores de validación en `AXEDA_INVALID_INPUT`. */
export function asInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (
      error instanceof AxedaError &&
      (error.code === 'AXEDA_INVALID_CONFIG' || error.code === 'AXEDA_INVALID_PERMISSION')
    ) {
      throw invalidInput(error.message.replace(/^Invalid Axeda options: /, ''));
    }
    throw error;
  }
}

/**
 * Pasa de un alcance guardado a uno evaluable. Para un negocio, la compañía sale de la base de
 * datos (T2), nunca de la petición; sin resolvedor o con un negocio inexistente se rechaza.
 */
export async function resolveTarget(
  services: Services,
  scope: AssignmentScope,
): Promise<TargetScope> {
  if (scope.type === 'global') return { type: 'global' };
  if (scope.type === 'company') return { type: 'company', companyId: scope.id };
  const companyId = (await services.scopes?.companyOfBusiness(scope.id)) ?? null;
  if (companyId === null) {
    throw invalidInput(
      services.scopes === undefined
        ? 'Business scopes are not available: no scope resolver is configured.'
        : `Business "${scope.id}" does not exist.`,
    );
  }
  return { type: 'business', companyId, businessId: scope.id };
}

/** Permisos de quien actúa, leídos de los almacenes de la transacción (nunca de la caché). */
export async function actorPermissions(
  stores: AxedaStores,
  services: Services,
  actor: Principal,
  target: TargetScope,
): Promise<PermissionSet> {
  assertPrincipal(actor);
  const snapshot = await loadSnapshot(stores, actor.userId);
  return effectivePermissions({
    ...snapshot,
    target,
    now: services.clock.now(),
    mfaEnabled: actor.twoFactorEnabled,
  });
}

/**
 * Sube la versión de cada usuario, **en orden**, como primer paso de la transacción.
 *
 * Además de invalidar su caché, esto toma el bloqueo de esa fila: una concesión y una revocación
 * de los permisos de quien concede no pueden solaparse (la segunda espera a la primera y
 * entonces lee datos ya confirmados). El orden fijo evita bloqueos mutuos entre dos usuarios.
 */
export async function lockUsers(stores: AxedaStores, userIds: readonly string[]): Promise<void> {
  for (const userId of [...new Set(userIds)].sort()) {
    await stores.authz.bumpUserVersion(userId);
  }
}
