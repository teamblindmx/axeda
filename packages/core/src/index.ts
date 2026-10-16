// @axeda/core — dominio, política de autorización, casos de uso y puertos.
export {
  createAxeda,
  type Axeda,
  type AxedaDependencies,
  type ScopeFilter,
} from './application/create-axeda.js';
export type { AssignInput, AssignmentService } from './application/assignments.js';
export type { InvitationInput, InvitationService } from './application/invitations.js';
export type {
  BusinessInput,
  BusinessService,
  BusinessUpdate,
  CompanyInput,
  CompanyService,
  CompanyUpdate,
  DeleteOptions,
  ListOptions,
} from './application/tenants.js';
export type { PublicIdentity, PurgeResult } from './application/tenant-lifecycle.js';
export type { BootstrapInput, BootstrapResult } from './application/bootstrap.js';
export type { RoleInput, RoleService, RoleUpdate } from './application/roles.js';
export {
  SUPER_ADMIN_ROLE_KEY,
  type InvitationDelivery,
  type InvitationMessage,
} from './application/services.js';
export { assertTransactional, isTransactional } from './application/startup-checks.js';
export { MAX_MENU_DEPTH, type MenuDefinition, type ResolvedMenu } from './config/menus.js';
export { pickLabel, type MenuNode } from './application/menu.js';
export type { BanInput, UserInput, UserService } from './application/users.js';
export {
  DEFAULT_LIMITS,
  resolveOptions,
  type AxedaOptions,
  type ResolvedOptions,
  type ResolvedRoleDefinition,
  type RoleDefinition,
} from './config/options.js';
export {
  AXEDA_CATALOG,
  AXEDA_PERMISSION_SCOPES,
  AXEDA_PERMISSIONS,
} from './domain/axeda-permissions.js';
export {
  WILDCARD,
  covers,
  isPermissionKey,
  isWildcard,
  parsePermissionKey,
  permissionKeyProblem,
  type PermissionKey,
} from './domain/permission-key.js';
export {
  invitationState,
  withoutSecret,
  type Invitation,
  type InvitationState,
  type StoredInvitation,
} from './domain/invitation.js';
export { isBanned, type ManagedUser } from './domain/user.js';
export {
  SLUG_PATTERN,
  businessKey,
  companyKey,
  isUsable,
  type Business,
  type Company,
  type TenantMetadata,
  type TenantStatus,
} from './domain/tenant.js';
export {
  MAX_AUDIT_METADATA_BYTES,
  createAuditIdFactory,
  type AuditAction,
  type AuditEvent,
  type AuditOutcome,
  type AuditTargetType,
  type NewAuditEvent,
} from './domain/audit.js';
export type {
  Actor,
  Principal,
  RequestMeta,
  Role,
  RoleAssignment,
  RoleStatus,
} from './domain/role.js';
export {
  GLOBAL_SCOPE,
  GLOBAL_TARGET,
  assignmentApplies,
  sameAssignmentScope,
  scopeContains,
  scopeKey,
  type AssignmentScope,
  type ScopeType,
  type TargetScope,
} from './domain/scope.js';
export { AxedaError, isAxedaError, type AxedaErrorCode } from './errors.js';
export * from './policy/index.js';
export * from './ports/index.js';
