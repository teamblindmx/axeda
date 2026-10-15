import {
  AxedaError,
  GLOBAL_SCOPE,
  parsePermissionKey,
  type AssignmentScope,
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
