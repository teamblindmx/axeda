import type { Business, Company, Site, TenantMetadata, TenantStatus } from '../domain/tenant.js';
import type { Invitation, InvitationChannel, StoredInvitation } from '../domain/invitation.js';
import type { AssignmentScope } from '../domain/scope.js';
import type { Page, PageRequest } from './paging.js';

/** Qué hacer con las entidades borradas (en periodo de gracia) al listar. */
export type DeletedFilter = 'exclude' | 'include' | 'only';

export interface TenantFilter {
  /** Solo estos identificadores. Una lista vacía no devuelve nada. */
  readonly ids?: readonly string[] | undefined;
  readonly deleted?: DeletedFilter | undefined;
}

export interface NewCompany {
  readonly slug: string;
  readonly name: string;
  readonly legalName?: string | null | undefined;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: TenantMetadata | undefined;
}

export interface CompanyChanges {
  readonly name?: string | undefined;
  readonly legalName?: string | null | undefined;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: TenantMetadata | undefined;
}

export interface NewBusiness {
  readonly companyId: string;
  readonly slug: string;
  readonly name: string;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: TenantMetadata | undefined;
}

export interface BusinessChanges {
  readonly name?: string | undefined;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: TenantMetadata | undefined;
}

export interface NewSite {
  readonly companyId: string;
  /** El negocio del que cuelga (de esa misma compañía), o `null`/ausente si cuelga de la compañía. */
  readonly businessId?: string | null | undefined;
  readonly slug: string;
  readonly name: string;
  readonly logoUrl?: string | null | undefined;
  readonly faviconUrl?: string | null | undefined;
  readonly metadata?: TenantMetadata | undefined;
}

export type SiteChanges = BusinessChanges;

export interface SiteFilter extends TenantFilter {
  /**
   * Solo las sedes de ese negocio, o con `null` solo las que cuelgan directamente de la compañía.
   * Sin él, todas las de la compañía.
   */
  readonly businessId?: string | null | undefined;
  /**
   * Restringe a lo que alguien puede ver sin administrar la compañía entera: las sedes de
   * `siteIds` **o** las de los negocios de `businessIds`. Con las dos listas vacías no devuelve nada.
   */
  readonly visible?:
    { readonly siteIds: readonly string[]; readonly businessIds: readonly string[] } | undefined;
}

/**
 * Operaciones comunes de compañías y negocios. Todo cambio exige la versión leída y la sube;
 * si otra persona cambió la entidad entre tanto, lanza `AXEDA_VERSION_CONFLICT`.
 */
interface TenantStore<T, TChanges> {
  get(id: string): Promise<T | null>;
  getMany(ids: readonly string[]): Promise<readonly T[]>;
  update(id: string, expectedVersion: number, changes: TChanges): Promise<T>;
  setStatus(id: string, expectedVersion: number, status: TenantStatus): Promise<T>;
  /** Borrado lógico (`at`) o restauración (`null`). */
  setDeleted(id: string, expectedVersion: number, at: Date | null): Promise<T>;
  /** Entidades borradas antes de `before`, para purgarlas. */
  listDeletedBefore(before: Date, limit: number): Promise<readonly T[]>;
}

export interface CompanyStore extends TenantStore<Company, CompanyChanges> {
  getBySlug(slug: string): Promise<Company | null>;
  list(filter: TenantFilter, page: PageRequest): Promise<Page<Company>>;
  /** Lanza `AXEDA_SLUG_TAKEN` si el slug ya existe. */
  create(input: NewCompany): Promise<Company>;
  /**
   * Borra de verdad las compañías **y todo lo suyo**: sus negocios, sus sedes, las asignaciones y
   * las invitaciones de esos alcances. Devuelve cuántas compañías se borraron.
   */
  purge(ids: readonly string[]): Promise<number>;
}

export interface BusinessStore extends TenantStore<Business, BusinessChanges> {
  /** El slug es único dentro de su compañía. */
  getBySlug(companyId: string, slug: string): Promise<Business | null>;
  listForCompany(
    companyId: string,
    filter: TenantFilter,
    page: PageRequest,
  ): Promise<Page<Business>>;
  /** Lanza `AXEDA_COMPANY_NOT_FOUND` o `AXEDA_SLUG_TAKEN`. */
  create(input: NewBusiness): Promise<Business>;
  /**
   * Borra de verdad los negocios, **sus sedes** y las asignaciones e invitaciones de esos
   * alcances. Devuelve cuántos negocios se borraron.
   */
  purge(ids: readonly string[]): Promise<number>;
}

export interface SiteStore extends TenantStore<Site, SiteChanges> {
  /** El slug es único dentro de su compañía (cuelgue o no de un negocio). */
  getBySlug(companyId: string, slug: string): Promise<Site | null>;
  /** Ordenadas por slug. */
  listForCompany(companyId: string, filter: SiteFilter, page: PageRequest): Promise<Page<Site>>;
  /**
   * Lanza `AXEDA_COMPANY_NOT_FOUND`, `AXEDA_BUSINESS_NOT_FOUND` (también si el negocio es de otra
   * compañía) o `AXEDA_SLUG_TAKEN`.
   */
  create(input: NewSite): Promise<Site>;
  /** Borra de verdad las sedes y las asignaciones e invitaciones de su alcance. */
  purge(ids: readonly string[]): Promise<number>;
}

export interface NewInvitation {
  /** Por omisión `email`. */
  readonly channel?: InvitationChannel | undefined;
  /** En minúsculas; vacío en una invitación por teléfono. */
  readonly email: string;
  /** E.164; solo en una invitación por teléfono. */
  readonly phoneNumber?: string | null | undefined;
  readonly scope: AssignmentScope;
  readonly roleIds: readonly string[];
  readonly invitedBy: string;
  readonly expiresAt: Date;
  /** Hash del secreto. El secreto en sí nunca se guarda. */
  readonly secretHash: string;
}

export interface InvitationStore {
  get(id: string): Promise<StoredInvitation | null>;
  /**
   * La invitación pendiente (no aceptada, no revocada) de ese contacto en ese alcance. El contacto
   * es el correo o, en una invitación por teléfono, el número (ver `invitationContact`).
   */
  findPending(contact: string, scope: AssignmentScope): Promise<StoredInvitation | null>;
  /** Lanza `AXEDA_INVITATION_EXISTS` si ya hay una pendiente para ese contacto y alcance. */
  create(input: NewInvitation): Promise<StoredInvitation>;
  /**
   * Cierra una invitación pendiente de forma **atómica**: de dos llamadas simultáneas solo una
   * devuelve `true`. Una aceptada o revocada no vuelve a quedar pendiente.
   */
  close(id: string, outcome: 'accepted' | 'revoked', at: Date): Promise<boolean>;
  list(
    scope: AssignmentScope,
    options: { readonly pendingOnly: boolean; readonly now: Date },
    page: PageRequest,
  ): Promise<Page<Invitation>>;
}
