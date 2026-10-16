import type { ResolvedOptions } from '../config/options.js';
import type { PermissionKey } from '../domain/permission-key.js';
import type { Principal } from '../domain/role.js';
import type { AssignmentScope, TargetScope } from '../domain/scope.js';
import { isUsable } from '../domain/tenant.js';
import { AxedaError } from '../errors.js';
import { effectivePermissions, type PermissionSet } from '../policy/effective-permissions.js';
import type { UserAdmin, UserDirectory } from '../ports/identity.js';
import type { AxedaPersistence, AxedaStores } from '../ports/persistence.js';
import type { Clock } from '../ports/platform.js';
import { assertPrincipal, loadSnapshot } from './authz-reader.js';

/** Clave reservada de la función total que crea `bootstrap`. */
export const SUPER_ADMIN_ROLE_KEY = 'super-admin';

/** Envío de invitaciones: Axeda genera el secreto; la aplicación decide cómo hacerlo llegar. */
export interface InvitationMessage {
  readonly email: string;
  /** El secreto de un solo uso. Es lo único que permite aceptar la invitación. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly scope: AssignmentScope;
  /** Quien invitó. */
  readonly invitedBy: string;
}

export interface InvitationDelivery {
  /** Envía el correo. No se llama dentro de la transacción. */
  send(message: InvitationMessage): Promise<void>;
}

/** Dependencias compartidas por los casos de uso. */
export interface Services {
  readonly persistence: AxedaPersistence;
  readonly clock: Clock;
  readonly options: ResolvedOptions;
  readonly catalog: ReadonlySet<PermissionKey>;
  readonly users: UserDirectory;
  /** Sin esto la administración de usuarios está desactivada. */
  readonly userAdmin: UserAdmin | undefined;
  /** Sin esto las invitaciones están desactivadas. */
  readonly delivery: InvitationDelivery | undefined;
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
 * Pasa de un alcance guardado a uno evaluable, **leyendo la base de datos** (T2): la compañía de
 * un negocio nunca se toma de la petición. Se usa FUERA de las transacciones.
 *
 * Con `requireUsable` (para conceder o invitar) la compañía o el negocio deben existir y estar
 * activos y sin borrar; sin él basta con que existan (para revocar o consultar).
 */
export async function resolveTarget(
  services: Services,
  scope: AssignmentScope,
  options: { readonly requireUsable: boolean } = { requireUsable: true },
): Promise<TargetScope> {
  if (scope.type === 'global') return { type: 'global' };
  const acceptable = <T extends Tenant>(entity: T | null): entity is T =>
    entity !== null && (!options.requireUsable || isUsable(entity));
  const { companies, businesses } = services.persistence;

  if (scope.type === 'company') {
    if (!acceptable(await companies.get(scope.id))) throw refuse('Company', scope.id);
    return { type: 'company', companyId: scope.id };
  }
  const business = await businesses.get(scope.id);
  if (!acceptable(business)) throw refuse('Business', scope.id);
  if (!acceptable(await companies.get(business.companyId))) throw refuse('Business', scope.id);
  return { type: 'business', companyId: business.companyId, businessId: business.id };
}

type Tenant = { readonly status: 'active' | 'inactive'; readonly deletedAt: Date | null };

const refuse = (kind: string, id: string): AxedaError =>
  invalidInput(`${kind} "${id}" does not exist or is not active.`);

/**
 * Permisos de quien actúa, leídos de los almacenes (nunca de la caché). Las asignaciones en
 * compañías o negocios inactivos o borrados no cuentan, pero el estado del **destino** no anula
 * los permisos: un administrador global debe poder restaurar o limpiar una compañía borrada.
 */
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
    banned: actor.banned,
    ignoreTargetStatus: true,
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

/**
 * Resuelve el alcance en nombre de `actor`. Si no se puede (compañía o negocio inexistente o
 * inactivo), solo quien tiene `permission` a nivel **global** ve el motivo; para los demás es la
 * denegación `onDenied`, sin revelar si la entidad existe.
 */
export async function resolveForActor(
  services: Services,
  stores: AxedaStores,
  actor: Principal,
  scope: AssignmentScope,
  options: {
    readonly permission: PermissionKey;
    readonly onDenied: () => Error;
    readonly requireUsable?: boolean;
  },
): Promise<TargetScope> {
  try {
    return await resolveTarget(services, scope, { requireUsable: options.requireUsable ?? true });
  } catch (error) {
    const global = await actorPermissions(stores, services, actor, { type: 'global' });
    if (global.allows(options.permission)) throw error;
    throw options.onDenied();
  }
}
