import type { BetterAuthPluginDBSchema } from '@better-auth/core/db';

/** Nombres de los modelos que Axeda añade al esquema de Better Auth. */
export const MODELS = {
  role: 'axedaRole',
  assignment: 'axedaAssignment',
  state: 'axedaState',
  audit: 'axedaAudit',
} as const;

/** Fila única de `axedaState` que guarda la versión de política (ADR-0005). */
export const POLICY_STATE_KEY = 'policy';

/**
 * Valor guardado en `scopeId` para una asignación global. Es una cadena vacía y no `null`
 * porque un índice único trata los `NULL` como distintos: con `null` podrían duplicarse
 * asignaciones globales.
 */
export const GLOBAL_SCOPE_ID = '';

/**
 * Esquema que el plugin añade a Better Auth. Las migraciones las genera Better Auth a partir
 * de esto (`getMigrations` o su CLI). Reglas: columnas nuevas siempre opcionales o con valor
 * por defecto; un cambio destructivo exige una migración manual.
 */
export const axedaSchema = {
  user: {
    fields: {
      /** Sube con cada cambio que afecta a la autorización de ese usuario (ADR-0005). */
      authzVersion: { type: 'number', required: false, defaultValue: 0, input: false },
    },
  },
  [MODELS.role]: {
    fields: {
      key: { type: 'string', required: true, unique: true, input: false },
      name: { type: 'string', required: true, input: false },
      description: { type: 'string', required: false, input: false },
      permissions: { type: 'string[]', required: true, input: false },
      requireMfa: { type: 'boolean', required: true, defaultValue: false, input: false },
      status: { type: 'string', required: true, defaultValue: 'active', input: false },
      managed: { type: 'boolean', required: true, defaultValue: false, input: false },
      version: { type: 'number', required: true, defaultValue: 1, input: false },
      createdAt: { type: 'date', required: true, input: false },
      updatedAt: { type: 'date', required: true, input: false },
    },
  },
  [MODELS.assignment]: {
    fields: {
      userId: {
        type: 'string',
        required: true,
        input: false,
        references: { model: 'user', field: 'id', onDelete: 'cascade' },
      },
      roleId: {
        type: 'string',
        required: true,
        input: false,
        references: { model: MODELS.role, field: 'id', onDelete: 'cascade' },
      },
      scopeType: { type: 'string', required: true, input: false },
      scopeId: { type: 'string', required: true, input: false },
      grantedBy: { type: 'string', required: false, input: false },
      createdAt: { type: 'date', required: true, input: false },
      expiresAt: { type: 'date', required: false, input: false },
    },
    indexes: [
      { fields: ['userId', 'roleId', 'scopeType', 'scopeId'], unique: true },
      { fields: ['scopeType', 'scopeId'] },
    ],
  },
  [MODELS.state]: {
    fields: {
      key: { type: 'string', required: true, unique: true, input: false },
      version: { type: 'number', required: true, defaultValue: 0, input: false },
    },
  },
  [MODELS.audit]: {
    fields: {
      // Sin clave foránea: la auditoría debe sobrevivir al borrado del usuario.
      actorId: { type: 'string', required: false, input: false },
      action: { type: 'string', required: true, input: false },
      targetType: { type: 'string', required: true, input: false },
      targetId: { type: 'string', required: false, input: false },
      scopeType: { type: 'string', required: false, input: false },
      scopeId: { type: 'string', required: false, input: false },
      outcome: { type: 'string', required: true, input: false },
      ip: { type: 'string', required: false, input: false },
      userAgent: { type: 'string', required: false, input: false },
      metadata: { type: 'json', required: true, input: false },
      at: { type: 'date', required: true, input: false },
    },
    indexes: [
      { fields: ['actorId'] },
      { fields: ['targetType', 'targetId'] },
      { fields: ['scopeType', 'scopeId'] },
    ],
  },
} satisfies BetterAuthPluginDBSchema;
