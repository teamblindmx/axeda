import { rejectUnknownOptions } from '@teamblind/axeda-core';
import type { AssignmentScope } from '@teamblind/axeda-core';

/** Lo que se necesita de la petición para leer el alcance (`req.params` y `req.query`). */
export interface ScopeRequest {
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
}

/** Dónde pide la ruta que se compruebe el permiso. */
export type RequestedScope =
  | { readonly kind: 'global' }
  | {
      readonly kind: 'scope';
      readonly scope: AssignmentScope;
      /** Si la ruta nombra también la compañía, el negocio o la sede deben ser de ella (T2). */
      readonly companyMustBe?: string;
      /** Si la ruta nombra también el negocio, la sede debe colgar de él (T2). */
      readonly businessMustBe?: string;
    }
  /** La petición no trae el alcance bien formado: se deniega, no se adivina. */
  | { readonly kind: 'invalid' };

export type ScopeResolver = (request: ScopeRequest) => RequestedScope;

/** La ruta no es de ninguna compañía, negocio ni sede: el permiso se comprueba en global. */
export const globalScope: ScopeResolver = () => ({ kind: 'global' });

export interface ScopeSource {
  /** Nombre del parámetro con el identificador de la compañía. */
  readonly company?: string;
  /** Nombre del parámetro con el identificador del negocio. */
  readonly business?: string;
  /** Nombre del parámetro con el identificador de la sede. */
  readonly site?: string;
  /** Dónde viene: en la ruta (`/companies/:companyId/…`, por defecto) o en la consulta (`?companyId=`). */
  readonly from?: 'params' | 'query';
}

const MAX_ID_LENGTH = 255;

/** Un identificador válido es un texto no vacío y corto: un arreglo (`?a=1&a=2`) o un objeto no. */
function readId(bag: Record<string, unknown>, name: string): string | undefined {
  const value = bag[name];
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
}

/**
 * Lee el alcance de la ruta. **El identificador es lo que dice el cliente; no se confía en él**:
 * `requirePermission` lo resuelve contra la base de datos (la compañía de un negocio sale de ahí)
 * y, si no existe o no le corresponde, la respuesta es la misma que sin permiso.
 *
 * ```ts
 * resolveScope({ company: 'companyId' })                       // /companies/:companyId/invoices
 * resolveScope({ company: 'companyId', business: 'businessId' }) // el negocio debe ser de esa compañía
 * resolveScope({ company: 'companyId', from: 'query' })        // /invoices?companyId=…
 * resolveScope({ company: 'companyId', site: 'siteId' })       // la sede debe ser de esa compañía
 * ```
 */
const SCOPE_SOURCE = Object.keys({
  company: true,
  business: true,
  site: true,
  from: true,
} satisfies Record<keyof ScopeSource, true>);

export function resolveScope(source: ScopeSource): ScopeResolver {
  // `resolveScope({ compnay: 'companyId' })` no leería ningún alcance: es un error, no global.
  rejectUnknownOptions('resolveScope()', source, SCOPE_SOURCE);
  const from = source.from ?? 'params';
  return (request) => {
    const bag = request[from];
    const company = source.company === undefined ? undefined : readId(bag, source.company);
    const business = source.business === undefined ? undefined : readId(bag, source.business);

    if (source.site !== undefined) {
      return siteScope(source, readId(bag, source.site), company, business);
    }
    if (source.business !== undefined) return businessScope(source, company, business);
    if (source.company !== undefined) {
      return company === undefined
        ? { kind: 'invalid' }
        : { kind: 'scope', scope: { type: 'company', id: company } };
    }
    return { kind: 'global' };
  };
}

/** Un negocio y, si la ruta la nombra, la compañía de la que debe ser. */
function businessScope(
  source: ScopeSource,
  company: string | undefined,
  business: string | undefined,
): RequestedScope {
  // Si el parámetro no vino o no es un texto válido, se deniega.
  if (business === undefined) return { kind: 'invalid' };
  if (source.company !== undefined && company === undefined) return { kind: 'invalid' };
  return {
    kind: 'scope',
    scope: { type: 'business', id: business },
    ...(company === undefined ? {} : { companyMustBe: company }),
  };
}

/**
 * Una sede, y lo que la ruta diga además de ella: si nombra la compañía o el negocio, la sede debe
 * colgar de ellos. Cualquier parámetro que falte o no sea válido deniega.
 */
function siteScope(
  source: ScopeSource,
  site: string | undefined,
  company: string | undefined,
  business: string | undefined,
): RequestedScope {
  if (site === undefined) return { kind: 'invalid' };
  if (source.company !== undefined && company === undefined) return { kind: 'invalid' };
  if (source.business !== undefined && business === undefined) return { kind: 'invalid' };
  return {
    kind: 'scope',
    scope: { type: 'site', id: site },
    ...(company === undefined ? {} : { companyMustBe: company }),
    ...(business === undefined ? {} : { businessMustBe: business }),
  };
}
