import { resolveOptions, type AxedaOptions, type ResolvedOptions } from '../config/options.js';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import { isWildcard, parsePermissionKey, type PermissionKey } from '../domain/permission-key.js';
import type { Actor, Principal } from '../domain/role.js';
import { GLOBAL_TARGET, type AssignmentScope, type TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import {
  effectivePermissions,
  permissionsHeldAnywhere,
  scopesGranting,
  type PermissionSet,
} from '../policy/effective-permissions.js';
import type { UserAdmin, UserDirectory } from '../ports/identity.js';
import type { AuditFilter, AxedaPersistence, Page, PageRequest } from '../ports/persistence.js';
import { systemClock, type Clock } from '../ports/platform.js';
import type { AuditEvent } from '../domain/audit.js';
import { createAssignmentService, type AssignmentService } from './assignments.js';
import { buildMenu, type MenuNode } from './menu.js';
import { createUserService, type UserService } from './users.js';
import { AuthzCache } from './authz-cache.js';
import { AuthzReader } from './authz-reader.js';
import { bootstrapAdministrator, type BootstrapInput, type BootstrapResult } from './bootstrap.js';
import { syncManagedRoles } from './managed-roles.js';
import { createRoleService, type RoleService } from './roles.js';
import { createInvitationService, type InvitationService } from './invitations.js';
import {
  actorPermissions,
  resolveTarget,
  type InvitationDelivery,
  type Services,
} from './services.js';
import {
  purgeExpiredDeletions,
  publicIdentity,
  type PublicIdentity,
  type PurgeResult,
} from './tenant-lifecycle.js';
import { createTenantServices, type BusinessService, type CompanyService } from './tenants.js';
import { assertTransactional } from './startup-checks.js';

export interface AxedaDependencies {
  readonly persistence: AxedaPersistence;
  /** Dónde Axeda consulta a los usuarios (con Better Auth, `createBetterAuthUserDirectory`). */
  readonly users: UserDirectory;
  readonly clock?: Clock;
  /**
   * Administración de usuarios (crear, bloquear, cerrar sesiones). Sin esto está desactivada
   * (con Better Auth, `createBetterAuthUserAdmin`).
   */
  readonly userAdmin?: UserAdmin;
  /**
   * Cómo hacer llegar las invitaciones. Axeda genera el secreto y llama a `send`; la aplicación
   * decide el correo. Sin esto las invitaciones están desactivadas.
   */
  readonly invitations?: InvitationDelivery;
}

/** Alcances donde se concede un permiso, listos para filtrar las consultas de la aplicación. */
export interface ScopeFilter {
  /** Se concede en global: no hay que filtrar. */
  readonly unrestricted: boolean;
  /** Compañías donde se concede (incluye todos sus negocios). */
  readonly companyIds: readonly string[];
  /** Negocios concretos donde se concede. */
  readonly businessIds: readonly string[];
}

export interface Axeda {
  /** Permisos de la aplicación más los propios de Axeda. */
  readonly catalog: readonly PermissionKey[];
  readonly options: ResolvedOptions;
  /**
   * Comprueba la persistencia (transacciones reales) y sincroniza las funciones declaradas en el
   * código. Es idempotente; si falla, el error se memoriza y ninguna operación posterior
   * funciona con una persistencia sin verificar. Las demás operaciones también lo esperan.
   */
  start(): Promise<void>;
  /** Permisos efectivos del usuario en `target` (global por defecto). */
  effectivePermissions(principal: Principal, target?: TargetScope): Promise<PermissionSet>;
  /** ¿Puede el usuario ejercer `permission` en `target`? Se deniega por defecto. */
  can(principal: Principal, permission: string, target?: TargetScope): Promise<boolean>;
  /** ¿Tiene el usuario `permission` en algún alcance? Para decidir qué listados mostrar. */
  canAnywhere(principal: Principal, permission: string): Promise<boolean>;
  /**
   * Pasa de un alcance que llega en una petición (el `id` de una compañía o negocio) al lugar
   * donde decidir un permiso, **leyendo la base de datos**: la compañía de un negocio nunca se
   * toma de la petición (T2). `null` si no existe. Para proteger rutas de tu aplicación.
   */
  resolveTarget(scope: AssignmentScope): Promise<TargetScope | null>;
  /** Alcances (global, compañías, negocios) donde el usuario tiene `permission`. */
  scopesFor(principal: Principal, permission: string): Promise<readonly AssignmentScope[]>;
  /** Lo mismo, en forma cómoda para filtrar las consultas de la aplicación (T5). */
  scopeFilter(principal: Principal, permission: string): Promise<ScopeFilter>;
  readonly roles: RoleService;
  readonly assignments: AssignmentService;
  readonly companies: CompanyService;
  readonly businesses: BusinessService;
  readonly invitations: InvitationService;
  readonly users: UserService;
  /**
   * El menú de la persona en un alcance (global por defecto): solo lo que tiene permiso de ver.
   * Un alcance que no existe o está inactivo da un menú vacío, sin revelar nada.
   */
  menu(
    principal: Principal,
    options?: {
      readonly scope?: AssignmentScope | undefined;
      readonly locale?: string | undefined;
    },
  ): Promise<MenuNode[]>;
  /** Identidad pública de una compañía o negocio activo, o `null`. No requiere sesión. */
  publicIdentity(query: {
    readonly company: string;
    readonly business?: string | undefined;
  }): Promise<PublicIdentity | null>;
  /**
   * Borra de verdad lo que lleva borrado más de `retention.graceDays`. La aplicación lo llama
   * (p. ej. desde un cron); Axeda no corre tareas en segundo plano.
   */
  purgeDeleted(): Promise<PurgeResult>;
  /** Auditoría: global con `axeda:audit:read` global; de una compañía, con ese permiso allí. */
  listAudit(actor: Actor, filter: AuditFilter, page: PageRequest): Promise<Page<AuditEvent>>;
  /** Crea el primer administrador global (operación del servidor, no de la API). */
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
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
  const reader = new AuthzReader(persistence, new AuthzCache(resolved.limits.maxCachedUsers));

  let started: Promise<void> | undefined;
  const services: Services = {
    persistence,
    clock,
    options: resolved,
    catalog: catalogSet,
    users: dependencies.users,
    delivery: dependencies.invitations,
    userAdmin: dependencies.userAdmin,
    ready: () => start(),
  };
  const start = (): Promise<void> =>
    (started ??= (async () => {
      await assertTransactional(persistence);
      await syncManagedRoles(services);
    })());

  async function snapshotData(principal: Principal, target?: TargetScope) {
    await start();
    const { snapshot, policyVersion } = await reader.read(principal);
    // Dentro de una compañía o negocio inactivo, borrado o inexistente no se puede hacer nada.
    const unusable =
      target === undefined || target.type === 'global'
        ? snapshot.unusable
        : new Set([
            ...snapshot.unusable,
            ...(await reader.unusableForTarget(policyVersion, target)),
          ]);
    return {
      assignments: snapshot.assignments,
      roles: snapshot.roles,
      unusable,
      now: clock.now(),
      mfaEnabled: principal.twoFactorEnabled,
      banned: principal.banned,
    };
  }

  async function effective(principal: Principal, target: TargetScope): Promise<PermissionSet> {
    return effectivePermissions({ ...(await snapshotData(principal, target)), target });
  }

  async function scopesFor(principal: Principal, permission: string) {
    const key = requirePermission(catalogSet, permission);
    return scopesGranting(await snapshotData(principal), key);
  }

  /**
   * El alcance en que se evalúa quién lee la auditoría. No exige que la compañía exista ni esté
   * activa (se debe poder auditar lo borrado); de un negocio desconocido solo lee quien lo es en global.
   */
  async function auditTarget(scope: AssignmentScope | undefined): Promise<TargetScope> {
    if (scope === undefined || scope.type === 'global') return GLOBAL_TARGET;
    if (scope.type === 'company') return { type: 'company', companyId: scope.id };
    const business = await persistence.businesses.get(scope.id);
    return business === null
      ? GLOBAL_TARGET
      : { type: 'business', companyId: business.companyId, businessId: business.id };
  }

  /**
   * Del alcance de una petición al lugar donde decidir. Si no existe da `null` (sin revelar
   * por qué); un alcance inactivo o borrado sí se resuelve, y `can` lo deniega por su estado.
   */
  async function targetOf(scope: AssignmentScope | undefined): Promise<TargetScope | null> {
    if (scope === undefined) return GLOBAL_TARGET;
    await start();
    try {
      return await resolveTarget(services, scope, { requireUsable: false });
    } catch {
      return null;
    }
  }

  const tenants = createTenantServices(services);

  return {
    catalog: resolved.catalog,
    options: resolved,
    start,
    effectivePermissions: (principal, target = GLOBAL_TARGET) => effective(principal, target),
    async can(principal, permission, target = GLOBAL_TARGET) {
      const key = requirePermission(catalogSet, permission);
      return (await effective(principal, target)).allows(key);
    },
    async canAnywhere(principal, permission) {
      const key = requirePermission(catalogSet, permission);
      return permissionsHeldAnywhere(await snapshotData(principal)).allows(key);
    },
    resolveTarget: (scope) => targetOf(scope),
    scopesFor,
    async scopeFilter(principal, permission) {
      const scopes = await scopesFor(principal, permission);
      return {
        unrestricted: scopes.some((scope) => scope.type === 'global'),
        companyIds: scopes.flatMap((scope) => (scope.type === 'company' ? [scope.id] : [])),
        businessIds: scopes.flatMap((scope) => (scope.type === 'business' ? [scope.id] : [])),
      };
    },
    roles: createRoleService(services),
    assignments: createAssignmentService(services),
    companies: tenants.companies,
    businesses: tenants.businesses,
    invitations: createInvitationService(services),
    users: createUserService(services),
    async menu(principal, menuOptions = {}) {
      const target = await targetOf(menuOptions.scope);
      if (target === null) return [];
      return buildMenu(resolved.menus, await effective(principal, target), menuOptions.locale);
    },
    publicIdentity: (query) => publicIdentity(services, query),
    purgeDeleted: () => purgeExpiredDeletions(services),
    async listAudit(actor, filter, page) {
      await start();
      const target = await auditTarget(filter.scope);
      const held = await actorPermissions(persistence, services, actor, target);
      if (!held.allows(AXEDA_PERMISSIONS.auditRead)) {
        throw new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to read the audit log.');
      }
      return persistence.audit.list(filter, page);
    },
    bootstrap: (input) => bootstrapAdministrator(services, input),
  };
}
