// @teamblind/axeda-express — protege las rutas de tu aplicación con los permisos de Axeda.
export {
  createAxedaExpress,
  type AxedaExpress,
  type AxedaExpressOptions,
  type DeniedDetail,
  type DeniedEvent,
  type DeniedReason,
  type PrincipalResolver,
  type RequirePermissionOptions,
} from './middleware.js';
export {
  globalScope,
  resolveScope,
  type RequestedScope,
  type ScopeRequest,
  type ScopeResolver,
  type ScopeSource,
} from './scope.js';
