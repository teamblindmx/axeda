import type { BetterAuthPluginDBSchema } from '@better-auth/core/db';

/** Nombres de los modelos que Axeda añade al esquema de Better Auth. */
export const MODELS = {
  role: 'axedaRole',
  assignment: 'axedaAssignment',
  state: 'axedaState',
  audit: 'axedaAudit',
  company: 'axedaCompany',
  business: 'axedaBusiness',
  invitation: 'axedaInvitation',
} as const;

/** Fila única de `axedaState` que guarda la versión de política. */
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
      /** Sube con cada cambio que afecta a la autorización de ese usuario. */
      authzVersion: { type: 'number', required: false, defaultValue: 0, input: false },
      // Mismos nombres y tipos que el plugin `admin` de Better Auth, para que convivan.
      banned: { type: 'boolean', required: false, defaultValue: false, input: false },
      banReason: { type: 'string', required: false, input: false },
      banExpires: { type: 'date', required: false, input: false },
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
  [MODELS.company]: {
    fields: {
      slug: { type: 'string', required: true, unique: true, input: false },
      name: { type: 'string', required: true, input: false },
      legalName: { type: 'string', required: false, input: false },
      logoUrl: { type: 'string', required: false, input: false },
      faviconUrl: { type: 'string', required: false, input: false },
      status: { type: 'string', required: true, defaultValue: 'active', input: false },
      metadata: { type: 'json', required: true, input: false },
      version: { type: 'number', required: true, defaultValue: 1, input: false },
      deletedAt: { type: 'date', required: false, input: false },
      createdAt: { type: 'date', required: true, input: false },
      updatedAt: { type: 'date', required: true, input: false },
    },
    indexes: [{ fields: ['deletedAt'] }],
  },
  [MODELS.business]: {
    fields: {
      companyId: {
        type: 'string',
        required: true,
        input: false,
        references: { model: MODELS.company, field: 'id', onDelete: 'cascade' },
      },
      slug: { type: 'string', required: true, input: false },
      name: { type: 'string', required: true, input: false },
      logoUrl: { type: 'string', required: false, input: false },
      faviconUrl: { type: 'string', required: false, input: false },
      status: { type: 'string', required: true, defaultValue: 'active', input: false },
      metadata: { type: 'json', required: true, input: false },
      version: { type: 'number', required: true, defaultValue: 1, input: false },
      deletedAt: { type: 'date', required: false, input: false },
      createdAt: { type: 'date', required: true, input: false },
      updatedAt: { type: 'date', required: true, input: false },
    },
    indexes: [{ fields: ['companyId', 'slug'], unique: true }, { fields: ['deletedAt'] }],
  },
  [MODELS.invitation]: {
    fields: {
      email: { type: 'string', required: true, input: false },
      scopeType: { type: 'string', required: true, input: false },
      scopeId: { type: 'string', required: true, input: false },
      roleIds: { type: 'string[]', required: true, input: false },
      // Sin clave foránea: la invitación puede sobrevivir al usuario que invitó.
      invitedBy: { type: 'string', required: true, input: false },
      secretHash: { type: 'string', required: true, input: false },
      expiresAt: { type: 'date', required: true, input: false },
      acceptedAt: { type: 'date', required: false, input: false },
      revokedAt: { type: 'date', required: false, input: false },
      /**
       * Clave única mientras la invitación está pendiente (hash de correo + alcance); al
       * cerrarla pasa a `closed:<id>`. Así dos invitaciones iguales a la vez no caben, sin
       * depender de índices parciales que no todas las bases tienen.
       */
      pendingKey: { type: 'string', required: true, unique: true, input: false },
      /** 0 mientras está pendiente. Se sube con `incrementOne`: solo un cierre lo consigue. */
      consumed: { type: 'number', required: true, defaultValue: 0, input: false },
      createdAt: { type: 'date', required: true, input: false },
    },
    indexes: [{ fields: ['scopeType', 'scopeId'] }, { fields: ['email'] }],
  },
} satisfies BetterAuthPluginDBSchema;
