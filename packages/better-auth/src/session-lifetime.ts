import { AxedaError } from '@teamblind/axeda-core';

/** Treinta días: tras ese tiempo hay que volver a iniciar sesión, por mucho que se use. */
export const DEFAULT_MAX_SESSION_AGE = 30 * 24 * 60 * 60;

/**
 * La vida máxima de una sesión, en segundos, o `undefined` si se desactivó con `false`.
 * Un valor que no sea un entero positivo es un error de configuración, no se corrige en silencio.
 */
export function resolveMaxSessionAge(value: number | false | undefined): number | undefined {
  if (value === false) return undefined;
  if (value === undefined) return DEFAULT_MAX_SESSION_AGE;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AxedaError(
      'AXEDA_INVALID_CONFIG',
      `maxSessionAge must be a positive whole number of seconds, or false to turn it off (got ${String(value)}).`,
    );
  }
  return value;
}

const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
};

/**
 * Recorta cuándo caduca una sesión para que nunca pase de su creación más `maxAge`. Devuelve
 * `undefined` si no hay nada que recortar.
 */
export function cappedExpiry(
  expiresAt: unknown,
  createdAt: unknown,
  maxAge: number,
): Date | undefined {
  const expiry = asDate(expiresAt);
  const created = asDate(createdAt);
  if (expiry === undefined || created === undefined) return undefined;
  const limit = created.getTime() + maxAge * 1000;
  return expiry.getTime() > limit ? new Date(limit) : undefined;
}

/**
 * La sesión que Better Auth está renovando. Una renovación solo trae la nueva fecha de caducidad;
 * la fila (con su `createdAt`) está en el contexto de la petición, donde Better Auth la leyó
 * justo antes. Sin petición (un trabajo que llama a `updateSession` por su cuenta) no hay de dónde
 * sacarla y la renovación se deja pasar.
 */
export function sessionBeingRefreshed(
  context: unknown,
): { readonly createdAt: unknown } | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const inner = (context as { context?: { session?: { session?: { createdAt?: unknown } } } })
    .context;
  const row = inner?.session?.session;
  return row === undefined || row === null ? undefined : { createdAt: row.createdAt };
}
