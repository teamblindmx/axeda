import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { AuditAction } from '../domain/audit.js';
import type { PermissionKey } from '../domain/permission-key.js';
import type { Actor } from '../domain/role.js';
import { GLOBAL_TARGET, type AssignmentScope, type TargetScope } from '../domain/scope.js';
import {
  isUsable,
  type Business,
  type Company,
  type Site,
  type TenantStatus,
} from '../domain/tenant.js';
import { AxedaError } from '../errors.js';
import { effectivePermissions, liveAssignmentScopes } from '../policy/effective-permissions.js';
import type { AxedaStores, DeletedFilter, Page, PageRequest, SiteFilter } from '../ports/index.js';
import { auditDenials, markDenied, writeAudit, type AuditDraft } from './audit.js';
import { loadSnapshot } from './authz-reader.js';
import {
  businessChangesSchema,
  businessInputSchema,
  companyChangesSchema,
  companyInputSchema,
  onlyDefined,
  parseInput,
  siteChangesSchema,
  siteInputSchema,
  siteParentSchema,
} from './tenant-input.js';
import { actorPermissions, actorPolicyData, invalidInput, type Services } from './services.js';
import type { ImageRecord } from '../domain/image.js';
import { deleteImageObjects } from './image-objects.js';
import { deleteStaffUsers } from './staff-cleanup.js';
import type { StaffAccount } from '../domain/staff.js';

/** Lo que sale con una compañía, negocio o sede purgada ahora mismo. */
interface Purged {
  readonly images: readonly ImageRecord[];
  readonly staff: readonly StaffAccount[];
}
const NOTHING_PURGED: Purged = { images: [], staff: [] };

/** Las imágenes y el personal de lo que se purga: los registros, dentro de la transacción. */
async function purgeOwned(
  stores: AxedaStores,
  owners: Parameters<AxedaStores['images']['deleteOwnedBy']>[0],
): Promise<Purged> {
  // Una tras otra: en SQLite la transacción tiene una sola conexión.
  const images = await stores.images.deleteOwnedBy(owners);
  const staff = await stores.staff.deleteOwnedBy(owners);
  return { images, staff };
}

/** Después de confirmar: los objetos de las imágenes y los usuarios del personal. */
async function cleanUpPurged(services: Services, purged: Purged): Promise<void> {
  await deleteImageObjects(services, purged.images);
  await deleteStaffUsers(services, purged.staff);
}

/**
 * Qué compañías, negocios y sedes puede ver quien pregunta (no confundir con lo que puede hacer en
 * ellos).
 */
interface Membership {
  /** Administra la plataforma: ve todas las compañías, también las borradas. */
  readonly platform: boolean;
  /** Compañías donde tiene una asignación de alcance de compañía. */
  readonly companyWide: ReadonlySet<string>;
  /** Compañías donde tiene alguna asignación, incluidas las de sus negocios y sus sedes. */
  readonly companies: ReadonlySet<string>;
  /** Negocios donde tiene una asignación de alcance de negocio (ve también sus sedes). */
  readonly businesses: ReadonlySet<string>;
  /** Sedes donde tiene una asignación de alcance de sede. */
  readonly sites: ReadonlySet<string>;
}

const PLATFORM_PERMISSIONS = [
  AXEDA_PERMISSIONS.companyManage,
  AXEDA_PERMISSIONS.businessManage,
  AXEDA_PERMISSIONS.siteManage,
  AXEDA_PERMISSIONS.assignmentManage,
  AXEDA_PERMISSIONS.invitationManage,
  AXEDA_PERMISSIONS.auditRead,
];

export interface CompanyInput {
  readonly slug: string;
  readonly name: string;
  readonly legalName?: string | null | undefined;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}
export interface CompanyUpdate {
  readonly name?: string | undefined;
  readonly legalName?: string | null | undefined;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface BusinessInput {
  readonly slug: string;
  readonly name: string;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}
export interface BusinessUpdate {
  readonly name?: string | undefined;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface SiteInput {
  /** El negocio (de la misma compañía) del que cuelga; sin él, cuelga de la compañía. */
  readonly businessId?: string | null | undefined;
  readonly slug: string;
  readonly name: string;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}
export type SiteUpdate = BusinessUpdate;

export interface ListOptions {
  /** Solo quien administra la plataforma puede pedir borradas. */
  readonly deleted?: DeletedFilter | undefined;
}

export interface SiteListOptions extends ListOptions {
  /** Solo las sedes de ese negocio, o con `null` las que cuelgan directamente de la compañía. */
  readonly businessId?: string | null | undefined;
}

export interface DeleteOptions {
  /** Borra de verdad ya, sin periodo de gracia (p. ej. una solicitud de eliminación de datos). */
  readonly immediate?: boolean | undefined;
}

export interface CompanyService {
  list(actor: Actor, options: ListOptions, page: PageRequest): Promise<Page<Company>>;
  get(actor: Actor, id: string): Promise<Company>;
  create(actor: Actor, input: CompanyInput): Promise<Company>;
  update(actor: Actor, id: string, version: number, changes: CompanyUpdate): Promise<Company>;
  setStatus(actor: Actor, id: string, version: number, status: TenantStatus): Promise<Company>;
  /** Borrado lógico (se puede restaurar durante el periodo de gracia) o, con `immediate`, definitivo. */
  delete(actor: Actor, id: string, version: number, options?: DeleteOptions): Promise<void>;
  restore(actor: Actor, id: string, version: number): Promise<Company>;
}

export interface BusinessService {
  list(
    actor: Actor,
    companyId: string,
    options: ListOptions,
    page: PageRequest,
  ): Promise<Page<Business>>;
  get(actor: Actor, id: string): Promise<Business>;
  create(actor: Actor, companyId: string, input: BusinessInput): Promise<Business>;
  update(actor: Actor, id: string, version: number, changes: BusinessUpdate): Promise<Business>;
  setStatus(actor: Actor, id: string, version: number, status: TenantStatus): Promise<Business>;
  delete(actor: Actor, id: string, version: number, options?: DeleteOptions): Promise<void>;
  restore(actor: Actor, id: string, version: number): Promise<Business>;
}

export interface SiteService {
  /** Las sedes de una compañía que quien pregunta puede ver, ordenadas por slug. */
  list(
    actor: Actor,
    companyId: string,
    options: SiteListOptions,
    page: PageRequest,
  ): Promise<Page<Site>>;
  get(actor: Actor, id: string): Promise<Site>;
  create(actor: Actor, companyId: string, input: SiteInput): Promise<Site>;
  update(actor: Actor, id: string, version: number, changes: SiteUpdate): Promise<Site>;
  setStatus(actor: Actor, id: string, version: number, status: TenantStatus): Promise<Site>;
  delete(actor: Actor, id: string, version: number, options?: DeleteOptions): Promise<void>;
  restore(actor: Actor, id: string, version: number): Promise<Site>;
}

/** Una compañía, negocio o sede, según `type`. */
export type TenantEntity =
  | { readonly type: 'company'; readonly entity: Company }
  | { readonly type: 'business'; readonly entity: Business }
  | { readonly type: 'site'; readonly entity: Site };

/**
 * Trabajo sobre una compañía, negocio o sede con **las mismas reglas que `update`**: 404 si no se
 * ve, después el permiso dentro de la transacción, y la entidad recién leída. Para las imágenes.
 */
export type OnTenant = <T>(
  actor: Actor,
  type: 'company' | 'business' | 'site',
  id: string,
  action: AuditAction,
  work: (stores: AxedaStores, tenant: TenantEntity) => Promise<T>,
) => Promise<T>;

export function createTenantServices(services: Services): {
  companies: CompanyService;
  businesses: BusinessService;
  sites: SiteService;
  onTenant: OnTenant;
} {
  const { persistence } = services;

  const forbid = (reason: string): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to do that.', { details: { reason } }),
    );
  const hiddenCompany = (id: string): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${id}" does not exist.`, {
        details: { reason: 'not_visible' },
      }),
    );
  const hiddenBusiness = (id: string): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_BUSINESS_NOT_FOUND', `Business "${id}" does not exist.`, {
        details: { reason: 'not_visible' },
      }),
    );
  const hiddenSite = (id: string): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_SITE_NOT_FOUND', `Site "${id}" does not exist.`, {
        details: { reason: 'not_visible' },
      }),
    );

  const draft = (
    actor: Actor,
    action: AuditAction,
    targetType: 'company' | 'business' | 'site',
    id: string | null,
    scope: AssignmentScope | null,
    metadata: Record<string, unknown> = {},
  ): AuditDraft => ({
    actorId: actor.userId,
    action,
    targetType,
    targetId: id,
    scope,
    meta: actor,
    metadata,
  });

  async function membershipOf(actor: Actor): Promise<Membership> {
    const snapshot = await loadSnapshot(persistence, actor.userId, services.options.features);
    const data = actorPolicyData(services, actor, snapshot);
    const global = effectivePermissions({
      ...data,
      target: GLOBAL_TARGET,
      ignoreTargetStatus: true,
    });
    const scopes = liveAssignmentScopes(data);
    const idsOf = (type: 'company' | 'business' | 'site') =>
      scopes.flatMap((scope) => (scope.type === type ? [scope.id] : []));
    const businessIds = idsOf('business');
    const siteIds = idsOf('site');
    const [parents, siteParents] = await Promise.all([
      businessIds.length === 0 ? [] : persistence.businesses.getMany(businessIds),
      siteIds.length === 0 ? [] : persistence.sites.getMany(siteIds),
    ]);
    const companyWide = new Set(idsOf('company'));
    return {
      platform: PLATFORM_PERMISSIONS.some((permission) => global.allows(permission)),
      companyWide,
      companies: new Set([
        ...companyWide,
        ...parents.map((business) => business.companyId),
        ...siteParents.map((site) => site.companyId),
      ]),
      businesses: new Set(businessIds),
      sites: new Set(siteIds),
    };
  }

  const canSeeCompany = (m: Membership, id: string) => m.platform || m.companies.has(id);
  const canSeeBusiness = (m: Membership, business: Business) =>
    m.platform || m.companyWide.has(business.companyId) || m.businesses.has(business.id);
  /** Ve una sede quien ve toda su compañía, quien está en su negocio o quien está en ella. */
  const canSeeSite = (m: Membership, site: Site) =>
    m.platform ||
    m.companyWide.has(site.companyId) ||
    (site.businessId !== null && m.businesses.has(site.businessId)) ||
    m.sites.has(site.id);

  async function mustHold(
    stores: AxedaStores,
    actor: Actor,
    target: TargetScope,
    permission: PermissionKey,
  ): Promise<void> {
    const held = await actorPermissions(stores, services, actor, target);
    if (!held.allows(permission)) throw forbid('missing_permission');
  }

  /** Solo la administración de la plataforma puede pedir entidades borradas. */
  function deletedFilter(m: Membership, options: ListOptions): DeletedFilter {
    const wanted = options.deleted ?? 'exclude';
    if (wanted !== 'exclude' && !m.platform) throw forbid('deleted_requires_platform_admin');
    return wanted;
  }

  // ---------------- compañías ----------------

  /**
   * Una operación sobre una compañía existente: visibilidad (404 si no la ves), después permiso
   * (403) dentro de la transacción. `global` exige el permiso en global; si no, en la compañía.
   */
  async function onCompany<T>(
    actor: Actor,
    id: string,
    action: AuditAction,
    options: { global: boolean; invalidates: boolean },
    work: (stores: AxedaStores, company: Company) => Promise<T>,
  ): Promise<T> {
    await services.ready();
    const scope: AssignmentScope = { type: 'company', id };
    return auditDenials(persistence, draft(actor, action, 'company', id, scope), async () => {
      const company = await persistence.companies.get(id);
      if (company === null || !canSeeCompany(await membershipOf(actor), id))
        throw hiddenCompany(id);

      return persistence.transaction(async (stores) => {
        // El cambio de estado de una compañía afecta a todos sus usuarios: sube la versión de política.
        if (options.invalidates) await stores.authz.bumpPolicyVersion();
        const target: TargetScope = options.global
          ? GLOBAL_TARGET
          : { type: 'company', companyId: id };
        await mustHold(stores, actor, target, AXEDA_PERMISSIONS.companyManage);
        const fresh = await stores.companies.get(id);
        if (fresh === null) throw hiddenCompany(id);
        return work(stores, fresh);
      });
    });
  }

  const companies: CompanyService = {
    async list(actor, options, page) {
      await services.ready();
      const m = await membershipOf(actor);
      const deleted = deletedFilter(m, options);
      if (m.platform) return persistence.companies.list({ deleted }, page);
      return persistence.companies.list({ ids: [...m.companies], deleted }, page);
    },

    async get(actor, id) {
      await services.ready();
      const company = await persistence.companies.get(id);
      if (company === null || !canSeeCompany(await membershipOf(actor), id)) {
        throw new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${id}" does not exist.`);
      }
      return company;
    },

    async create(actor, input) {
      await services.ready();
      return auditDenials(
        persistence,
        draft(actor, 'company.create', 'company', null, null, { slug: String(input?.slug) }),
        () =>
          persistence.transaction(async (stores) => {
            // Autorizar antes de validar: quien no puede crear compañías no averigua nada.
            await mustHold(stores, actor, GLOBAL_TARGET, AXEDA_PERMISSIONS.companyManage);
            const parsed = parseInput(companyInputSchema, input);
            const created = await stores.companies.create(onlyDefined(parsed) as typeof parsed);
            await writeAudit(
              stores,
              draft(
                actor,
                'company.create',
                'company',
                created.id,
                { type: 'company', id: created.id },
                { slug: created.slug },
              ),
              'success',
            );
            return created;
          }),
      );
    },

    update: (actor, id, version, changes) =>
      onCompany(
        actor,
        id,
        'company.update',
        { global: false, invalidates: false },
        async (stores, company) => {
          const parsed = parseInput(companyChangesSchema, changes);
          const updated = await stores.companies.update(id, version, onlyDefined(parsed));
          await writeAudit(
            stores,
            draft(
              actor,
              'company.update',
              'company',
              id,
              { type: 'company', id },
              { slug: company.slug, fields: Object.keys(parsed) },
            ),
            'success',
          );
          return updated;
        },
      ),

    setStatus: (actor, id, version, status) =>
      onCompany(
        actor,
        id,
        'company.set_status',
        { global: true, invalidates: true },
        async (stores, company) => {
          if (status !== 'active' && status !== 'inactive')
            throw invalidInput('status must be "active" or "inactive".');
          const updated = await stores.companies.setStatus(id, version, status);
          await writeAudit(
            stores,
            draft(
              actor,
              'company.set_status',
              'company',
              id,
              { type: 'company', id },
              { slug: company.slug, status },
            ),
            'success',
          );
          return updated;
        },
      ),

    delete: async (actor, id, version, options = {}) => {
      const immediate = options.immediate === true;
      const removed = await onCompany(
        actor,
        id,
        immediate ? 'company.purge' : 'company.delete',
        { global: true, invalidates: true },
        async (stores, company) => {
          let purged = NOTHING_PURGED;
          if (immediate) {
            purged = await purgeOwned(stores, { companyIds: [id], businessIds: [], siteIds: [] });
            await stores.companies.purge([id]);
          } else {
            if (company.deletedAt !== null) throw invalidInput('The company is already deleted.');
            await stores.companies.setDeleted(id, version, services.clock.now());
          }
          await writeAudit(
            stores,
            draft(
              actor,
              immediate ? 'company.purge' : 'company.delete',
              'company',
              id,
              { type: 'company', id },
              { slug: company.slug },
            ),
            'success',
          );
          return purged;
        },
      );
      await cleanUpPurged(services, removed);
    },

    restore: (actor, id, version) =>
      onCompany(
        actor,
        id,
        'company.restore',
        { global: true, invalidates: true },
        async (stores, company) => {
          if (company.deletedAt === null) throw invalidInput('The company is not deleted.');
          const restored = await stores.companies.setDeleted(id, version, null);
          await writeAudit(
            stores,
            draft(
              actor,
              'company.restore',
              'company',
              id,
              { type: 'company', id },
              { slug: company.slug },
            ),
            'success',
          );
          return restored;
        },
      ),
  };

  // ---------------- negocios ----------------

  /** Una operación sobre un negocio existente. El permiso se comprueba en SU compañía. */
  async function onBusiness<T>(
    actor: Actor,
    id: string,
    action: AuditAction,
    invalidates: boolean,
    work: (stores: AxedaStores, business: Business) => Promise<T>,
  ): Promise<T> {
    await services.ready();
    return auditDenials(
      persistence,
      draft(actor, action, 'business', id, { type: 'business', id }),
      async () => {
        const business = await persistence.businesses.get(id);
        if (business === null || !canSeeBusiness(await membershipOf(actor), business))
          throw hiddenBusiness(id);

        return persistence.transaction(async (stores) => {
          if (invalidates) await stores.authz.bumpPolicyVersion();
          // La compañía sale de la base de datos (T2) y un negocio no puede cambiar de compañía.
          const target: TargetScope = { type: 'company', companyId: business.companyId };
          await mustHold(stores, actor, target, AXEDA_PERMISSIONS.businessManage);
          const fresh = await stores.businesses.get(id);
          if (fresh === null) throw hiddenBusiness(id);
          return work(stores, fresh);
        });
      },
    );
  }

  const businesses: BusinessService = {
    async list(actor, companyId, options, page) {
      await services.ready();
      const m = await membershipOf(actor);
      const company = await persistence.companies.get(companyId);
      if (company === null || !canSeeCompany(m, companyId)) {
        throw new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${companyId}" does not exist.`);
      }
      const deleted = deletedFilter(m, options);
      // Quien solo tiene asignaciones en negocios sueltos ve únicamente esos negocios.
      const wide = m.platform || m.companyWide.has(companyId);
      return persistence.businesses.listForCompany(
        companyId,
        wide ? { deleted } : { deleted, ids: [...m.businesses] },
        page,
      );
    },

    async get(actor, id) {
      await services.ready();
      const business = await persistence.businesses.get(id);
      if (business === null || !canSeeBusiness(await membershipOf(actor), business)) {
        throw new AxedaError('AXEDA_BUSINESS_NOT_FOUND', `Business "${id}" does not exist.`);
      }
      return business;
    },

    async create(actor, companyId, input) {
      await services.ready();
      const scope: AssignmentScope = { type: 'company', id: companyId };
      return auditDenials(
        persistence,
        draft(actor, 'business.create', 'business', null, scope),
        async () => {
          const company = await persistence.companies.get(companyId);
          if (company === null || !canSeeCompany(await membershipOf(actor), companyId)) {
            throw hiddenCompany(companyId);
          }
          return persistence.transaction(async (stores) => {
            await mustHold(
              stores,
              actor,
              {
                type: 'company',
                companyId,
              },
              AXEDA_PERMISSIONS.businessManage,
            );
            const parsed = parseInput(businessInputSchema, input);
            if (!isUsable(company)) throw invalidInput('The company is not active.');
            const created = await stores.businesses.create({
              ...(onlyDefined(parsed) as typeof parsed),
              companyId,
            });
            await writeAudit(
              stores,
              draft(
                actor,
                'business.create',
                'business',
                created.id,
                { type: 'business', id: created.id },
                { slug: created.slug, companyId },
              ),
              'success',
            );
            return created;
          });
        },
      );
    },

    update: (actor, id, version, changes) =>
      onBusiness(actor, id, 'business.update', false, async (stores, business) => {
        const parsed = parseInput(businessChangesSchema, changes);
        const updated = await stores.businesses.update(id, version, onlyDefined(parsed));
        await writeAudit(
          stores,
          draft(
            actor,
            'business.update',
            'business',
            id,
            { type: 'business', id },
            { slug: business.slug, fields: Object.keys(parsed) },
          ),
          'success',
        );
        return updated;
      }),

    setStatus: (actor, id, version, status) =>
      onBusiness(actor, id, 'business.set_status', true, async (stores, business) => {
        if (status !== 'active' && status !== 'inactive')
          throw invalidInput('status must be "active" or "inactive".');
        const updated = await stores.businesses.setStatus(id, version, status);
        await writeAudit(
          stores,
          draft(
            actor,
            'business.set_status',
            'business',
            id,
            { type: 'business', id },
            { slug: business.slug, status },
          ),
          'success',
        );
        return updated;
      }),

    delete: async (actor, id, version, options = {}) => {
      const immediate = options.immediate === true;
      const removed = await onBusiness(
        actor,
        id,
        immediate ? 'business.purge' : 'business.delete',
        true,
        async (stores, business) => {
          let purged = NOTHING_PURGED;
          if (immediate) {
            purged = await purgeOwned(stores, { companyIds: [], businessIds: [id], siteIds: [] });
            await stores.businesses.purge([id]);
          } else {
            if (business.deletedAt !== null) throw invalidInput('The business is already deleted.');
            await stores.businesses.setDeleted(id, version, services.clock.now());
          }
          await writeAudit(
            stores,
            draft(
              actor,
              immediate ? 'business.purge' : 'business.delete',
              'business',
              id,
              { type: 'business', id },
              { slug: business.slug },
            ),
            'success',
          );
          return purged;
        },
      );
      await cleanUpPurged(services, removed);
    },

    restore: (actor, id, version) =>
      onBusiness(actor, id, 'business.restore', true, async (stores, business) => {
        if (business.deletedAt === null) throw invalidInput('The business is not deleted.');
        const restored = await stores.businesses.setDeleted(id, version, null);
        await writeAudit(
          stores,
          draft(
            actor,
            'business.restore',
            'business',
            id,
            { type: 'business', id },
            { slug: business.slug },
          ),
          'success',
        );
        return restored;
      }),
  };

  // ---------------- sedes ----------------

  /** Dónde se administra una sede: en su negocio si cuelga de uno; si no, en su compañía. */
  const parentOf = (site: Pick<Site, 'companyId' | 'businessId'>): TargetScope =>
    site.businessId === null
      ? { type: 'company', companyId: site.companyId }
      : { type: 'business', companyId: site.companyId, businessId: site.businessId };

  /**
   * El negocio de una sede nueva, leído de la base de datos: debe existir y ser de esa compañía.
   * Uno de otra compañía no se distingue de uno que no existe.
   */
  async function businessForNewSite(
    stores: AxedaStores,
    companyId: string,
    businessId: string | null,
  ): Promise<Business | null> {
    if (businessId === null) return null;
    const business = await stores.businesses.get(businessId);
    if (business === null || business.companyId !== companyId) throw hiddenBusiness(businessId);
    return business;
  }

  /** El `businessId` de una entrada sin validar (la validación completa viene después). */
  const businessIdOf = (input: unknown): unknown =>
    typeof input === 'object' && input !== null
      ? (input as { businessId?: unknown }).businessId
      : undefined;

  /** Una operación sobre una sede existente. El permiso se comprueba donde se administra. */
  async function onSite<T>(
    actor: Actor,
    id: string,
    action: AuditAction,
    invalidates: boolean,
    work: (stores: AxedaStores, site: Site) => Promise<T>,
  ): Promise<T> {
    await services.ready();
    return auditDenials(
      persistence,
      draft(actor, action, 'site', id, { type: 'site', id }),
      async () => {
        const site = await persistence.sites.get(id);
        if (site === null || !canSeeSite(await membershipOf(actor), site)) throw hiddenSite(id);

        return persistence.transaction(async (stores) => {
          // El estado de una sede decide los permisos de su gente: sube la versión de política.
          if (invalidates) await stores.authz.bumpPolicyVersion();
          // La compañía y el negocio salen de la base de datos (T2); una sede no cambia de ninguno.
          await mustHold(stores, actor, parentOf(site), AXEDA_PERMISSIONS.siteManage);
          const fresh = await stores.sites.get(id);
          if (fresh === null) throw hiddenSite(id);
          return work(stores, fresh);
        });
      },
    );
  }

  const siteDraft = (actor: Actor, action: AuditAction, site: Site, extra = {}) =>
    draft(
      actor,
      action,
      'site',
      site.id,
      { type: 'site', id: site.id },
      { slug: site.slug, ...extra },
    );

  const sites: SiteService = {
    async list(actor, companyId, options, page) {
      await services.ready();
      const m = await membershipOf(actor);
      const company = await persistence.companies.get(companyId);
      if (company === null || !canSeeCompany(m, companyId)) {
        throw new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${companyId}" does not exist.`);
      }
      const filter: SiteFilter = {
        deleted: deletedFilter(m, options),
        ...(options.businessId === undefined ? {} : { businessId: options.businessId }),
      };
      // Quien no ve toda la compañía ve solo sus sedes y las de sus negocios.
      const wide = m.platform || m.companyWide.has(companyId);
      return persistence.sites.listForCompany(
        companyId,
        wide
          ? filter
          : { ...filter, visible: { siteIds: [...m.sites], businessIds: [...m.businesses] } },
        page,
      );
    },

    async get(actor, id) {
      await services.ready();
      const site = await persistence.sites.get(id);
      if (site === null || !canSeeSite(await membershipOf(actor), site)) {
        throw new AxedaError('AXEDA_SITE_NOT_FOUND', `Site "${id}" does not exist.`);
      }
      return site;
    },

    async create(actor, companyId, input) {
      await services.ready();
      const scope: AssignmentScope = { type: 'company', id: companyId };
      return auditDenials(
        persistence,
        draft(actor, 'site.create', 'site', null, scope),
        async () => {
          const company = await persistence.companies.get(companyId);
          if (company === null || !canSeeCompany(await membershipOf(actor), companyId)) {
            throw hiddenCompany(companyId);
          }
          // Solo el negocio elegido se lee antes de autorizar: decide DÓNDE se autoriza. El resto
          // se valida después, para que quien no puede crearla no aprenda nada.
          const chosen = parseInput(siteParentSchema, { businessId: businessIdOf(input) });
          const businessId = chosen.businessId ?? null;
          return persistence.transaction(async (stores) => {
            const business = await businessForNewSite(stores, companyId, businessId);
            await mustHold(
              stores,
              actor,
              parentOf({ companyId, businessId }),
              AXEDA_PERMISSIONS.siteManage,
            );
            const { businessId: _parent, ...fields } = parseInput(siteInputSchema, input);
            if (!isUsable(company)) throw invalidInput('The company is not active.');
            if (business !== null && !isUsable(business)) {
              throw invalidInput('The business is not active.');
            }
            const created = await stores.sites.create({
              ...(onlyDefined(fields) as typeof fields),
              companyId,
              businessId,
            });
            await writeAudit(
              stores,
              siteDraft(actor, 'site.create', created, { companyId, businessId }),
              'success',
            );
            return created;
          });
        },
      );
    },

    update: (actor, id, version, changes) =>
      onSite(actor, id, 'site.update', false, async (stores, site) => {
        const parsed = parseInput(siteChangesSchema, changes);
        const updated = await stores.sites.update(id, version, onlyDefined(parsed));
        await writeAudit(
          stores,
          siteDraft(actor, 'site.update', site, { fields: Object.keys(parsed) }),
          'success',
        );
        return updated;
      }),

    setStatus: (actor, id, version, status) =>
      onSite(actor, id, 'site.set_status', true, async (stores, site) => {
        if (status !== 'active' && status !== 'inactive')
          throw invalidInput('status must be "active" or "inactive".');
        const updated = await stores.sites.setStatus(id, version, status);
        await writeAudit(stores, siteDraft(actor, 'site.set_status', site, { status }), 'success');
        return updated;
      }),

    delete: async (actor, id, version, options = {}) => {
      const immediate = options.immediate === true;
      const action = immediate ? 'site.purge' : 'site.delete';
      const removed = await onSite(actor, id, action, true, async (stores, site) => {
        let purged = NOTHING_PURGED;
        if (immediate) {
          purged = await purgeOwned(stores, { companyIds: [], businessIds: [], siteIds: [id] });
          await stores.sites.purge([id]);
        } else {
          if (site.deletedAt !== null) throw invalidInput('The site is already deleted.');
          await stores.sites.setDeleted(id, version, services.clock.now());
        }
        await writeAudit(stores, siteDraft(actor, action, site), 'success');
        return purged;
      });
      await cleanUpPurged(services, removed);
    },

    restore: (actor, id, version) =>
      onSite(actor, id, 'site.restore', true, async (stores, site) => {
        if (site.deletedAt === null) throw invalidInput('The site is not deleted.');
        const restored = await stores.sites.setDeleted(id, version, null);
        await writeAudit(stores, siteDraft(actor, 'site.restore', site), 'success');
        return restored;
      }),
  };

  const onTenant: OnTenant = (actor, type, id, action, work) => {
    if (type === 'company') {
      return onCompany(actor, id, action, { global: false, invalidates: false }, (stores, entity) =>
        work(stores, { type, entity }),
      );
    }
    if (type === 'business') {
      return onBusiness(actor, id, action, false, (stores, entity) =>
        work(stores, { type, entity }),
      );
    }
    return onSite(actor, id, action, false, (stores, entity) => work(stores, { type, entity }));
  };

  return { companies, businesses, sites, onTenant };
}
