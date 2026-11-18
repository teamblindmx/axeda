export type TenantStatus = 'active' | 'inactive';

/** Detalles libres de una compañía o negocio, acotados en tamaño y profundidad (S12). */
export type TenantMetadata = Readonly<Record<string, unknown>>;

interface TenantBase {
  readonly id: string;
  /** Minúsculas, único. Identifica a la entidad en la identidad pública. */
  readonly slug: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly status: TenantStatus;
  readonly metadata: TenantMetadata;
  /** Concurrencia optimista: cada cambio exige la versión que se leyó. */
  readonly version: number;
  /** Borrado lógico: no es `null` durante el periodo de gracia. */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** La compañía es el límite de aislamiento entre clientes. */
export interface Company extends TenantBase {
  readonly legalName: string | null;
}

/** Un negocio pertenece a una compañía, y no puede cambiar de compañía. */
export interface Business extends TenantBase {
  readonly companyId: string;
}

/**
 * Una sede es un lugar (una ubicación) de una compañía. Pertenece siempre a una compañía y,
 * opcionalmente, a un negocio de esa misma compañía; no cambia de compañía ni de negocio. Una
 * compañía puede tener sedes sin tener negocios.
 */
export interface Site extends TenantBase {
  readonly companyId: string;
  /** El negocio del que cuelga, o `null` si cuelga directamente de la compañía. */
  readonly businessId: string | null;
}

/** ¿Puede esta entidad conceder poder? Una inactiva o borrada no concede nada. */
export const isUsable = (entity: { status: TenantStatus; deletedAt: Date | null }): boolean =>
  entity.status === 'active' && entity.deletedAt === null;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Claves de alcance (`scopeKey`) de una compañía, de un negocio y de una sede. */
export const companyKey = (companyId: string): string => `company:${companyId}`;
export const businessKey = (businessId: string): string => `business:${businessId}`;
export const siteKey = (siteId: string): string => `site:${siteId}`;
