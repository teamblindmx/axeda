import type { ImageRecord } from '../domain/image.js';
import { isUsable } from '../domain/tenant.js';
import { writeAudit } from './audit.js';
import { deleteImageObjects } from './image-objects.js';
import { sweepExpiredUploads } from './images.js';
import { deleteStaffUsers } from './staff-cleanup.js';
import type { Services } from './services.js';

/** Lo único que se publica de una compañía o negocio sin iniciar sesión. */
export interface PublicIdentity {
  readonly kind: 'company' | 'business';
  readonly slug: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  /** Para un negocio, la compañía a la que pertenece. */
  readonly company?: { readonly slug: string; readonly name: string };
}

/**
 * Identidad pública (nombre y logos) de una compañía o negocio **activo y sin borrar**.
 * Devuelve `null` tanto si no existe como si está inactivo o borrado: no se distingue (T10).
 */
export async function publicIdentity(
  services: Services,
  query: { readonly company: string; readonly business?: string | undefined },
): Promise<PublicIdentity | null> {
  await services.ready();
  const { companies, businesses } = services.persistence;
  const company = await companies.getBySlug(query.company);
  if (company === null || !isUsable(company)) return null;
  if (query.business === undefined) {
    return {
      kind: 'company',
      slug: company.slug,
      name: company.name,
      logoUrl: company.logoUrl,
      faviconUrl: company.faviconUrl,
    };
  }
  const business = await businesses.getBySlug(company.id, query.business);
  if (business === null || !isUsable(business)) return null;
  return {
    kind: 'business',
    slug: business.slug,
    name: business.name,
    logoUrl: business.logoUrl,
    faviconUrl: business.faviconUrl,
    company: { slug: company.slug, name: company.name },
  };
}

export interface PurgeResult {
  readonly companies: number;
  readonly businesses: number;
  readonly sites: number;
  /** Imágenes borradas: las de lo purgado y las subidas que nadie completó a tiempo. */
  readonly images: number;
}

const BATCH = 100;

/**
 * Borra de verdad las compañías, negocios y sedes cuyo periodo de gracia terminó (y todo lo suyo).
 * Axeda no corre tareas en segundo plano: la aplicación lo llama cuando quiera (p. ej. desde un
 * cron). Es una operación del servidor, igual que `bootstrap`; queda en la auditoría.
 */
export async function purgeExpiredDeletions(services: Services): Promise<PurgeResult> {
  await services.ready();
  const { persistence, clock, options } = services;
  const before = new Date(clock.now().getTime() - options.retention.graceDays * 86_400_000);
  let companies = 0;
  let businesses = 0;
  let sites = 0;
  let images = 0;

  for (;;) {
    const [oldCompanies, oldBusinesses, oldSites] = await Promise.all([
      persistence.companies.listDeletedBefore(before, BATCH),
      persistence.businesses.listDeletedBefore(before, BATCH),
      persistence.sites.listDeletedBefore(before, BATCH),
    ]);
    if (oldCompanies.length === 0 && oldBusinesses.length === 0 && oldSites.length === 0) break;

    const done = await persistence.transaction(async (stores) => {
      await stores.authz.bumpPolicyVersion();
      // Sus imágenes salen con ellas; los objetos se borran después de confirmar.
      const owners = {
        companyIds: oldCompanies.map((c) => c.id),
        businessIds: oldBusinesses.map((b) => b.id),
        siteIds: oldSites.map((s) => s.id),
      };
      const ownedImages: readonly ImageRecord[] = await stores.images.deleteOwnedBy(owners);
      const staff = await stores.staff.deleteOwnedBy(owners);
      // De abajo arriba: purgar un negocio o una compañía ya se lleva sus sedes.
      const removedSites = await stores.sites.purge(oldSites.map((s) => s.id));
      const removedBusinesses = await stores.businesses.purge(oldBusinesses.map((b) => b.id));
      const removedCompanies = await stores.companies.purge(oldCompanies.map((c) => c.id));
      const system = { actorId: null, scope: null } as const;
      for (const site of oldSites) {
        await writeAudit(
          stores,
          {
            ...system,
            action: 'site.purge',
            targetType: 'site',
            targetId: site.id,
            metadata: { slug: site.slug },
          },
          'success',
        );
      }
      for (const business of oldBusinesses) {
        await writeAudit(
          stores,
          {
            ...system,
            action: 'business.purge',
            targetType: 'business',
            targetId: business.id,
            metadata: { slug: business.slug },
          },
          'success',
        );
      }
      for (const company of oldCompanies) {
        await writeAudit(
          stores,
          {
            ...system,
            action: 'company.purge',
            targetType: 'company',
            targetId: company.id,
            metadata: { slug: company.slug },
          },
          'success',
        );
      }
      return {
        companies: removedCompanies,
        businesses: removedBusinesses,
        sites: removedSites,
        images: ownedImages,
        staff,
      };
    });
    await deleteImageObjects(services, done.images);
    await deleteStaffUsers(services, done.staff);
    companies += done.companies;
    businesses += done.businesses;
    sites += done.sites;
    images += done.images.length;
  }
  images += await sweepExpiredUploads(services);
  return { companies, businesses, sites, images };
}
