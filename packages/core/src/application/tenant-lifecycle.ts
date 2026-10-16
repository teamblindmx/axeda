import { isUsable } from '../domain/tenant.js';
import { writeAudit } from './audit.js';
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
}

const BATCH = 100;

/**
 * Borra de verdad las compañías y negocios cuyo periodo de gracia terminó (y todo lo suyo).
 * Axeda no corre tareas en segundo plano: la aplicación lo llama cuando quiera (p. ej. desde un
 * cron). Es una operación del servidor, igual que `bootstrap`; queda en la auditoría.
 */
export async function purgeExpiredDeletions(services: Services): Promise<PurgeResult> {
  await services.ready();
  const { persistence, clock, options } = services;
  const before = new Date(clock.now().getTime() - options.retention.graceDays * 86_400_000);
  let companies = 0;
  let businesses = 0;

  for (;;) {
    const [oldCompanies, oldBusinesses] = await Promise.all([
      persistence.companies.listDeletedBefore(before, BATCH),
      persistence.businesses.listDeletedBefore(before, BATCH),
    ]);
    if (oldCompanies.length === 0 && oldBusinesses.length === 0) break;

    const done = await persistence.transaction(async (stores) => {
      await stores.authz.bumpPolicyVersion();
      const removedBusinesses = await stores.businesses.purge(oldBusinesses.map((b) => b.id));
      const removedCompanies = await stores.companies.purge(oldCompanies.map((c) => c.id));
      const system = { actorId: null, scope: null } as const;
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
      return { companies: removedCompanies, businesses: removedBusinesses };
    });
    companies += done.companies;
    businesses += done.businesses;
  }
  return { companies, businesses };
}
