import { parsePermissionKey, type PermissionKey } from './permission-key.js';
import type { ScopeType } from './scope.js';

const key = parsePermissionKey;

/** Permisos con los que Axeda protege su propia administración. */
export const AXEDA_PERMISSIONS = Object.freeze({
  roleManage: key('axeda:role:manage'),
  assignmentManage: key('axeda:assignment:manage'),
  companyManage: key('axeda:company:manage'),
  businessManage: key('axeda:business:manage'),
  invitationManage: key('axeda:invitation:manage'),
  userManage: key('axeda:user:manage'),
  auditRead: key('axeda:audit:read'),
});

/** En qué alcances tiene sentido conceder cada permiso propio de Axeda. */
export const AXEDA_PERMISSION_SCOPES: Readonly<Record<string, readonly ScopeType[]>> =
  Object.freeze({
    [AXEDA_PERMISSIONS.roleManage]: ['global'],
    [AXEDA_PERMISSIONS.assignmentManage]: ['global', 'company', 'business'],
    [AXEDA_PERMISSIONS.companyManage]: ['global', 'company'],
    [AXEDA_PERMISSIONS.businessManage]: ['global', 'company'],
    [AXEDA_PERMISSIONS.invitationManage]: ['global', 'company', 'business'],
    [AXEDA_PERMISSIONS.userManage]: ['global'],
    [AXEDA_PERMISSIONS.auditRead]: ['global', 'company'],
  });

export const AXEDA_CATALOG: readonly PermissionKey[] = Object.freeze(
  Object.values(AXEDA_PERMISSIONS),
);
