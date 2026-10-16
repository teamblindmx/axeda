import type { AssignmentScope, AuditEvent, Role, RoleAssignment } from '@axeda/core';

/**
 * Salida por lista blanca (S17): cada respuesta enumera sus campos. Si el modelo gana un campo
 * nuevo, no sale por la API hasta que se añada aquí a propósito. Las fechas salen como texto ISO.
 */

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  requireMfa: boolean;
  status: 'active' | 'inactive';
  managed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentDto {
  id: string;
  userId: string;
  roleId: string;
  scope: AssignmentScope;
  grantedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface AuditEventDto {
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  scope: AssignmentScope | null;
  outcome: 'success' | 'denied';
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export const toRoleDto = (role: Role): RoleDto => ({
  id: role.id,
  key: role.key,
  name: role.name,
  description: role.description,
  permissions: [...role.permissions],
  requireMfa: role.requireMfa,
  status: role.status,
  managed: role.managed,
  version: role.version,
  createdAt: role.createdAt.toISOString(),
  updatedAt: role.updatedAt.toISOString(),
});

export const toAssignmentDto = (assignment: RoleAssignment): AssignmentDto => ({
  id: assignment.id,
  userId: assignment.userId,
  roleId: assignment.roleId,
  scope: assignment.scope,
  grantedBy: assignment.grantedBy,
  createdAt: assignment.createdAt.toISOString(),
  expiresAt: assignment.expiresAt?.toISOString() ?? null,
});

export const toAuditEventDto = (event: AuditEvent): AuditEventDto => ({
  id: event.id,
  at: event.at.toISOString(),
  actorId: event.actorId,
  action: event.action,
  targetType: event.targetType,
  targetId: event.targetId,
  scope: event.scope,
  outcome: event.outcome,
  ip: event.ip,
  userAgent: event.userAgent,
  metadata: { ...event.metadata },
});
