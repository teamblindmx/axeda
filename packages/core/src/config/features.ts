import { AXEDA_CATALOG } from '../domain/axeda-permissions.js';
import { covers, parsePermissionKey, type PermissionKey } from '../domain/permission-key.js';
import { AxedaError } from '../errors.js';

/** Una funcionalidad (un módulo) que la plataforma activa o no para cada compañía. */
export interface FeatureDefinition {
  /** Los permisos que dependen de ella: sin la funcionalidad, no valen dentro de esa compañía. */
  readonly permissions: readonly string[];
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  /** Encendida para las compañías que no tengan un ajuste propio. Por omisión, apagada. */
  readonly enabledByDefault?: boolean | undefined;
}

export interface ResolvedFeature {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly PermissionKey[];
  readonly enabledByDefault: boolean;
}

export const FEATURE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_FEATURES = 100;
const MAX_FEATURE_PERMISSIONS = 100;

const invalid = (message: string): never => {
  throw new AxedaError('AXEDA_INVALID_CONFIG', `Invalid Axeda options: ${message}`);
};

function resolveOne(
  key: string,
  definition: FeatureDefinition,
  catalog: readonly PermissionKey[],
): ResolvedFeature {
  if (!FEATURE_KEY.test(key)) invalid(`feature key "${key}" must match ${FEATURE_KEY.source}.`);
  const raw = definition.permissions;
  if (raw.length === 0) invalid(`feature "${key}" has no permissions.`);
  if (raw.length > MAX_FEATURE_PERMISSIONS) {
    invalid(`feature "${key}" has more than ${MAX_FEATURE_PERMISSIONS} permissions.`);
  }
  const permissions = [...new Set(raw)].map((permission) => {
    const parsed = parsePermissionKey(permission);
    // La administración de Axeda no depende de ningún plan: no se puede apagar por funcionalidad.
    if (AXEDA_CATALOG.some((axedaKey) => covers(parsed, axedaKey))) {
      invalid(`feature "${key}" uses "${permission}", which covers an Axeda permission.`);
    }
    if (!catalog.some((known) => covers(parsed, known))) {
      invalid(`feature "${key}" uses "${permission}", which matches no permission in the catalog.`);
    }
    return parsed;
  });
  return {
    key,
    name: definition.name ?? key,
    description: definition.description ?? null,
    permissions,
    enabledByDefault: definition.enabledByDefault === true,
  };
}

/** Valida las funcionalidades declaradas contra el catálogo de permisos. */
export function resolveFeatures(
  features: Readonly<Record<string, FeatureDefinition>> | undefined,
  catalog: readonly PermissionKey[],
): ReadonlyMap<string, ResolvedFeature> {
  const entries = Object.entries(features ?? {});
  if (entries.length > MAX_FEATURES) invalid(`more than ${MAX_FEATURES} features.`);
  return new Map(entries.map(([key, definition]) => [key, resolveOne(key, definition, catalog)]));
}
