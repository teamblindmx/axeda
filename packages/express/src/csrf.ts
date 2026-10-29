import { AxedaError } from '@axeda/core';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalise(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Orígenes de confianza, normalizados. Una entrada con comodín o con ruta es un error de configuración. */
export function trustedOriginSet(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0) {
    throw new AxedaError(
      'AXEDA_INVALID_CONFIG',
      'trustedOrigins is empty: list the front end origins, or pass csrf: false if this API never ' +
        'authenticates with cookies.',
    );
  }
  const set = new Set<string>();
  for (const raw of origins) {
    const origin = normalise(raw);
    if (origin === null || raw.includes('*') || new URL(raw).pathname !== '/') {
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        `trustedOrigins entry "${raw}" must be an origin like https://app.example.com.`,
      );
    }
    set.add(origin);
  }
  return set;
}

/**
 * ¿Es una petición entre sitios que puede hacer daño? Solo importa si es de las que cambian
 * cosas y viaja con cookie: sin cookie no hay credencial que el navegador adjunte por su cuenta.
 * Con cookie, el `Origin` debe ser de confianza; si falta o es `null`, se rechaza.
 */
export function isCrossSiteWrite(
  method: string,
  headers: {
    readonly cookie?: string | undefined;
    readonly origin?: string | string[] | undefined;
  },
  trusted: ReadonlySet<string>,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (headers.cookie === undefined || headers.cookie === '') return false;
  const { origin } = headers;
  if (typeof origin !== 'string') return true;
  const normalised = normalise(origin);
  return normalised === null || !trusted.has(normalised);
}
