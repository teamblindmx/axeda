// @axeda/better-auth — plugin de Better Auth y persistencia de Axeda sobre su adaptador.
export { axeda, type AxedaPlugin, type AxedaPluginOptions } from './plugin.js';
export type { AssignmentDto, AuditEventDto, RoleDto } from './dto.js';
export type { EndpointAccess } from './endpoints.js';
export { MODELS, axedaSchema } from './schema.js';
export { createBetterAuthPersistence, type BetterAuthPersistenceOptions } from './stores.js';
export { createBetterAuthUserDirectory } from './users.js';
