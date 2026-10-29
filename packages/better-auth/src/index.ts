// @axeda/better-auth — plugin de Better Auth y persistencia de Axeda sobre su adaptador.
export {
  axeda,
  type AxedaPlugin,
  type AxedaPluginOptions,
  type InvitationDeliveryOptions,
} from './plugin.js';
export type {
  AssignmentDto,
  AuditEventDto,
  BusinessDto,
  CompanyDto,
  InvitationDto,
  ManagedUserDto,
  RoleDto,
} from './dto.js';
export type { EndpointAccess } from './endpoints.js';
export { MODELS, axedaSchema } from './schema.js';
export { MAPPED_CODES } from './http-errors.js';
export { createBetterAuthPersistence, type BetterAuthPersistenceOptions } from './stores.js';
export { createBetterAuthUserDirectory } from './users.js';
export { createBetterAuthUserAdmin } from './user-admin.js';
export { actorFromSession as principalFromSession } from './endpoints.js';
export { principalFromUser, sessionPrincipal, type SessionReader } from './principal.js';
export { secureAuthOptions, type SecureAuthInput, type SecureAuthOptions } from './preset.js';
