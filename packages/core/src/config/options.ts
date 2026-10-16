import { z } from 'zod';
import { AXEDA_CATALOG } from '../domain/axeda-permissions.js';
import {
  covers,
  isWildcard,
  parsePermissionKey,
  permissionKeyProblem,
  type PermissionKey,
} from '../domain/permission-key.js';
import { AxedaError } from '../errors.js';

export interface RoleDefinition {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly permissions: readonly string[];
  readonly requireMfa?: boolean | undefined;
}

export interface AxedaOptions {
  /** Catálogo de permisos de la aplicación (concretos, sin comodines). */
  readonly permissions: readonly string[];
  /** Funciones declaradas en código (`managed`). La clave es el identificador estable. */
  readonly roles?: Readonly<Record<string, readonly string[] | RoleDefinition>>;
  /** Días que una compañía o negocio borrado se conserva antes de poder purgarse. */
  readonly retention?: { readonly graceDays?: number };
  readonly invitations?: {
    /** Horas de vigencia por defecto. */
    readonly ttlHours?: number;
    /** Máximo de funciones por invitación. */
    readonly maxRoles?: number;
  };
  readonly limits?: {
    readonly maxAssignmentsPerUser?: number;
    readonly maxPermissionsPerRole?: number;
    /** Usuarios cuyos permisos se guardan en la caché en memoria de cada proceso. */
    readonly maxCachedUsers?: number;
  };
}

export interface ResolvedRoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly PermissionKey[];
  readonly requireMfa: boolean;
}

export interface ResolvedOptions {
  /** Permisos de la aplicación más los propios de Axeda. */
  readonly catalog: readonly PermissionKey[];
  readonly roles: ReadonlyMap<string, ResolvedRoleDefinition>;
  readonly retention: { readonly graceDays: number };
  readonly invitations: { readonly ttlHours: number; readonly maxRoles: number };
  readonly limits: {
    readonly maxAssignmentsPerUser: number;
    readonly maxPermissionsPerRole: number;
    readonly maxCachedUsers: number;
  };
}

export const DEFAULT_RETENTION = Object.freeze({ graceDays: 30 });
export const DEFAULT_INVITATIONS = Object.freeze({ ttlHours: 72, maxRoles: 10 });

export const DEFAULT_LIMITS = Object.freeze({
  maxAssignmentsPerUser: 50,
  maxPermissionsPerRole: 100,
  maxCachedUsers: 10_000,
});

export const ROLE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const RESERVED_PREFIX = 'axeda:';

const limitSchema = z.number().int().positive().max(10_000);
const optionsSchema = z.strictObject({
  permissions: z.array(z.string()),
  roles: z
    .record(
      z.string(),
      z.union([
        z.array(z.string()),
        z.strictObject({
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(1000).optional(),
          permissions: z.array(z.string()),
          requireMfa: z.boolean().optional(),
        }),
      ]),
    )
    .optional(),
  retention: z.strictObject({ graceDays: z.number().int().min(0).max(3650).optional() }).optional(),
  invitations: z
    .strictObject({
      ttlHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .optional(),
      maxRoles: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      maxAssignmentsPerUser: limitSchema.optional(),
      maxPermissionsPerRole: limitSchema.optional(),
      maxCachedUsers: limitSchema.optional(),
    })
    .optional(),
});

const invalid = (message: string): never => {
  throw new AxedaError('AXEDA_INVALID_CONFIG', `Invalid Axeda options: ${message}`);
};

function parseShape(options: unknown): z.infer<typeof optionsSchema> {
  const result = optionsSchema.safeParse(options);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return invalid(detail);
}

function buildCatalog(permissions: readonly string[]): readonly PermissionKey[] {
  const seen = new Set<string>();
  for (const raw of permissions) {
    const problem = permissionKeyProblem(raw);
    if (problem !== null) invalid(`permission "${raw}" ${problem}.`);
    if (isWildcard(raw as PermissionKey))
      invalid(`permission "${raw}" cannot be a wildcard in the catalog.`);
    if (raw.startsWith(RESERVED_PREFIX))
      invalid(`permission "${raw}" uses the reserved "axeda:" prefix.`);
    if (seen.has(raw)) invalid(`permission "${raw}" is declared twice.`);
    seen.add(raw);
  }
  return [...AXEDA_CATALOG, ...permissions.map(parsePermissionKey)];
}

export function resolveRoleDefinition(
  key: string,
  raw: readonly string[] | RoleDefinition,
  catalog: readonly PermissionKey[],
  maxPermissions: number,
): ResolvedRoleDefinition {
  if (!ROLE_KEY.test(key)) invalid(`role key "${key}" must match ${ROLE_KEY.source}.`);
  const definition: RoleDefinition = Array.isArray(raw)
    ? { permissions: raw }
    : (raw as RoleDefinition);
  if (definition.permissions.length === 0) invalid(`role "${key}" has no permissions.`);
  if (definition.permissions.length > maxPermissions) {
    invalid(`role "${key}" has more than ${maxPermissions} permissions.`);
  }

  const permissions = [...new Set(definition.permissions)].map((permission) => {
    const parsed = parsePermissionKey(permission);
    // Un permiso que no cubre nada del catálogo es casi seguro un error tipográfico.
    if (!catalog.some((known) => covers(parsed, known))) {
      invalid(`role "${key}" uses "${permission}", which matches no permission in the catalog.`);
    }
    return parsed;
  });

  return {
    key,
    name: definition.name ?? key,
    description: definition.description ?? null,
    permissions,
    requireMfa: definition.requireMfa ?? false,
  };
}

type Shape = z.infer<typeof optionsSchema>;

const limitsOf = (limits: Shape['limits']): ResolvedOptions['limits'] => ({
  maxAssignmentsPerUser: limits?.maxAssignmentsPerUser ?? DEFAULT_LIMITS.maxAssignmentsPerUser,
  maxPermissionsPerRole: limits?.maxPermissionsPerRole ?? DEFAULT_LIMITS.maxPermissionsPerRole,
  maxCachedUsers: limits?.maxCachedUsers ?? DEFAULT_LIMITS.maxCachedUsers,
});

const retentionOf = (retention: Shape['retention']): ResolvedOptions['retention'] => ({
  graceDays: retention?.graceDays ?? DEFAULT_RETENTION.graceDays,
});

const invitationsOf = (invitations: Shape['invitations']): ResolvedOptions['invitations'] => ({
  ttlHours: invitations?.ttlHours ?? DEFAULT_INVITATIONS.ttlHours,
  maxRoles: invitations?.maxRoles ?? DEFAULT_INVITATIONS.maxRoles,
});

/** Valida las opciones y devuelve la configuración resuelta. Lanza `AXEDA_INVALID_CONFIG`. */
export function resolveOptions(options: AxedaOptions): ResolvedOptions {
  const shape = parseShape(options);
  const limits = limitsOf(shape.limits);
  const catalog = buildCatalog(shape.permissions);
  const roles = new Map<string, ResolvedRoleDefinition>();
  for (const [key, raw] of Object.entries(shape.roles ?? {})) {
    roles.set(key, resolveRoleDefinition(key, raw, catalog, limits.maxPermissionsPerRole));
  }
  return {
    catalog,
    roles,
    limits,
    retention: retentionOf(shape.retention),
    invitations: invitationsOf(shape.invitations),
  };
}
