// @axeda/core — dominio, política de autorización, casos de uso y puertos.
export { createAxeda, type Axeda, type AxedaDependencies } from './application/create-axeda.js';
export { assertTransactional, isTransactional } from './application/startup-checks.js';
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
export type { Principal, Role, RoleAssignment, RoleStatus } from './domain/role.js';
export {
  GLOBAL_SCOPE,
  GLOBAL_TARGET,
  assignmentApplies,
  sameAssignmentScope,
  scopeKey,
  type AssignmentScope,
  type ScopeType,
  type TargetScope,
} from './domain/scope.js';
export { AxedaError, isAxedaError, type AxedaErrorCode } from './errors.js';
export * from './policy/index.js';
export * from './ports/index.js';
