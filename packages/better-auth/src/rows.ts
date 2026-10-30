import {
  AxedaError,
  GLOBAL_SCOPE,
  parsePermissionKey,
  type AssignmentScope,
  type AuditAction,
  type AuditEvent,
  type AuditOutcome,
  type AuditTargetType,
  type Role,
  type RoleAssignment,
} from '@axeda/core';
import { GLOBAL_SCOPE_ID } from './schema.js';

/** Filas tal como las devuelve el adaptador de Better Auth. */
export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  permissions: readonly string[];
  requireMfa: boolean;
  status: string;
  managed: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentRow {
  id: string;
  userId: string;
  roleId: string;
  scopeType: string;
  scopeId: string;
  grantedBy?: string | null;
  createdAt: Date;
  expiresAt?: Date | null;
}

const corrupt = (message: string): AxedaError => new AxedaError('AXEDA_DATA_CORRUPT', message);

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    // Un permiso corrupto lanza: es preferible fallar que decidir con datos dudosos.
    permissions: row.permissions.map(parsePermissionKey),
    requireMfa: row.requireMfa,
    // Un estado desconocido se trata como inactivo: ante la duda, se deniega.
    status: row.status === 'active' ? 'active' : 'inactive',
    managed: row.managed,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toScope(row: Pick<AssignmentRow, 'id' | 'scopeType' | 'scopeId'>): AssignmentScope {
  switch (row.scopeType) {
    case 'global':
      return GLOBAL_SCOPE;
    case 'company':
    case 'business':
      if (row.scopeId === GLOBAL_SCOPE_ID) {
        throw corrupt(`Assignment "${row.id}" has a ${row.scopeType} scope without an id.`);
      }
      return { type: row.scopeType, id: row.scopeId };
    default:
      throw corrupt(`Assignment "${row.id}" has an unknown scope type "${row.scopeType}".`);
  }
}

export function toAssignment(row: AssignmentRow): RoleAssignment {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    scope: toScope(row),
    grantedBy: row.grantedBy ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
  };
}

export const scopeColumns = (scope: AssignmentScope): { scopeType: string; scopeId: string } =>
  scope.type === 'global'
    ? { scopeType: 'global', scopeId: GLOBAL_SCOPE_ID }
    : { scopeType: scope.type, scopeId: scope.id };

export interface AuditRow {
  id: string;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  outcome: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata: Record<string, unknown>;
  at: Date;
}

export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    at: row.at,
    actorId: row.actorId ?? null,
    // Los valores los escribe Axeda; una fila ajena o corrupta se rechaza en vez de adivinarse.
    action: row.action as AuditAction,
    targetType: row.targetType as AuditTargetType,
    targetId: row.targetId ?? null,
    scope:
      row.scopeType === null || row.scopeType === undefined
        ? null
        : toScope({ id: row.id, scopeType: row.scopeType, scopeId: row.scopeId ?? '' }),
    outcome: row.outcome as AuditOutcome,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    metadata: row.metadata,
  };
}
