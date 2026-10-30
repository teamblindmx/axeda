import { AxedaError } from '../errors.js';

declare const permissionKeyBrand: unique symbol;

/**
 * Clave de permiso validada: `recurso:acción` (`invoice:create`), `axeda:role:manage`,
 * un comodín en el último segmento (`invoice:*`) o el comodín total `*`.
 */
export type PermissionKey = string & { readonly [permissionKeyBrand]: 'PermissionKey' };

export const WILDCARD = '*';
const SEGMENT = /^[a-z][a-z0-9_-]{0,31}$/;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 3;

/** Devuelve el motivo por el que la clave es inválida, o `null` si es válida. */
export function permissionKeyProblem(input: string): string | null {
  if (input === WILDCARD) return null;
  const segments = input.split(':');
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) {
    return `must have between ${MIN_SEGMENTS} and ${MAX_SEGMENTS} segments separated by ":"`;
  }
  const last = segments.length - 1;
  for (const [index, segment] of segments.entries()) {
    if (segment === WILDCARD && index === last) continue;
    if (!SEGMENT.test(segment)) {
      return segment.includes(WILDCARD)
        ? 'the wildcard "*" is only allowed as the whole last segment'
        : `segment "${segment}" must match ${SEGMENT.source}`;
    }
  }
  return null;
}

export function isPermissionKey(input: unknown): input is PermissionKey {
  return typeof input === 'string' && permissionKeyProblem(input) === null;
}

export function parsePermissionKey(input: string): PermissionKey {
  const problem = permissionKeyProblem(input);
  if (problem !== null) {
    throw new AxedaError('AXEDA_INVALID_PERMISSION', `Invalid permission "${input}": ${problem}.`);
  }
  return input as PermissionKey;
}

export function isWildcard(key: PermissionKey): boolean {
  return key.endsWith(WILDCARD);
}

/**
 * ¿`held` concede todo lo que concede `required`?
 * - `*` cubre cualquier clave.
 * - `a:*` cubre `a:b`, `a:b:c`, `a:b:*` y `a:*` (el comodín abarca uno o más segmentos).
 * - Una clave sin comodín solo se cubre a sí misma.
 * Es reflexiva y transitiva.
 */
export function covers(held: PermissionKey, required: PermissionKey): boolean {
  if (held === WILDCARD) return true;
  if (required === WILDCARD) return false;
  if (!held.endsWith(`:${WILDCARD}`)) return held === required;

  // "a:*" -> prefijo "a:". Una clave válida nunca termina en ":", así que si `required` empieza por
  // el prefijo, tiene al menos un segmento más.
  return required.startsWith(held.slice(0, -1));
}
