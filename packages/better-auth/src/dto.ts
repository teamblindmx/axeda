import type {
  AssignmentScope,
  AuditEvent,
  Business,
  Company,
  Invitation,
  Role,
  RoleAssignment,
} from '@axeda/core';

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

// ---------- compañías, negocios e invitaciones ----------

interface TenantDto {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  status: 'active' | 'inactive';
  metadata: Record<string, unknown>;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyDto extends TenantDto {
  legalName: string | null;
}

export interface BusinessDto extends TenantDto {
  companyId: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  scope: AssignmentScope;
  roleIds: string[];
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

const tenantFields = (entity: Company | Business): TenantDto => ({
  id: entity.id,
  slug: entity.slug,
  name: entity.name,
  logoUrl: entity.logoUrl,
  faviconUrl: entity.faviconUrl,
  status: entity.status,
  metadata: { ...entity.metadata },
  version: entity.version,
  deletedAt: entity.deletedAt?.toISOString() ?? null,
  createdAt: entity.createdAt.toISOString(),
  updatedAt: entity.updatedAt.toISOString(),
});

export const toCompanyDto = (company: Company): CompanyDto => ({
  ...tenantFields(company),
  legalName: company.legalName,
});

export const toBusinessDto = (business: Business): BusinessDto => ({
  ...tenantFields(business),
  companyId: business.companyId,
});

export const toInvitationDto = (invitation: Invitation): InvitationDto => ({
  id: invitation.id,
  email: invitation.email,
  scope: invitation.scope,
  roleIds: [...invitation.roleIds],
  invitedBy: invitation.invitedBy,
  expiresAt: invitation.expiresAt.toISOString(),
  createdAt: invitation.createdAt.toISOString(),
  acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  revokedAt: invitation.revokedAt?.toISOString() ?? null,
});
