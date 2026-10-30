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
      /** Si la ruta nombra también la compañía, el negocio debe ser de ella (T2). */
      readonly companyMustBe?: string;
    }
  /** La petición no trae el alcance bien formado: se deniega, no se adivina. */
  | { readonly kind: 'invalid' };

export type ScopeResolver = (request: ScopeRequest) => RequestedScope;

/** La ruta no es de ninguna compañía ni negocio: el permiso se comprueba en global. */
export const globalScope: ScopeResolver = () => ({ kind: 'global' });

export interface ScopeSource {
  /** Nombre del parámetro con el identificador de la compañía. */
  readonly company?: string;
  /** Nombre del parámetro con el identificador del negocio. */
  readonly business?: string;
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
 * ```
 */
export function resolveScope(source: ScopeSource): ScopeResolver {
  const from = source.from ?? 'params';
  return (request) => {
    const bag = request[from];
    const company = source.company === undefined ? undefined : readId(bag, source.company);
    const business = source.business === undefined ? undefined : readId(bag, source.business);

    if (source.business !== undefined) {
      // Si el parámetro no vino o no es un texto válido, se deniega.
      if (business === undefined) return { kind: 'invalid' };
      if (source.company !== undefined && company === undefined) return { kind: 'invalid' };
      return {
        kind: 'scope',
        scope: { type: 'business', id: business },
        ...(company === undefined ? {} : { companyMustBe: company }),
      };
    }
    if (source.company !== undefined) {
      return company === undefined
        ? { kind: 'invalid' }
        : { kind: 'scope', scope: { type: 'company', id: company } };
    }
    return { kind: 'global' };
  };
}
