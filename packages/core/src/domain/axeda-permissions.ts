import { parsePermissionKey, type PermissionKey } from './permission-key.js';
import type { ScopeType } from './scope.js';

const key = parsePermissionKey;

/** Permisos con los que Axeda protege su propia administración. */
export const AXEDA_PERMISSIONS = Object.freeze({
  roleManage: key('axeda:role:manage'),
  assignmentManage: key('axeda:assignment:manage'),
  companyManage: key('axeda:company:manage'),
  businessManage: key('axeda:business:manage'),
  siteManage: key('axeda:site:manage'),
  invitationManage: key('axeda:invitation:manage'),
  staffManage: key('axeda:staff:manage'),
  featureManage: key('axeda:feature:manage'),
  menuManage: key('axeda:menu:manage'),
  userManage: key('axeda:user:manage'),
  auditRead: key('axeda:audit:read'),
});

/** En qué alcances tiene sentido conceder cada permiso propio de Axeda. */
export const AXEDA_PERMISSION_SCOPES: Readonly<Record<string, readonly ScopeType[]>> =
  Object.freeze({
    [AXEDA_PERMISSIONS.roleManage]: ['global'],
    [AXEDA_PERMISSIONS.assignmentManage]: ['global', 'company', 'business', 'site'],
    [AXEDA_PERMISSIONS.companyManage]: ['global', 'company'],
    [AXEDA_PERMISSIONS.businessManage]: ['global', 'company'],
    // Las sedes se administran desde arriba: la compañía, o el negocio del que cuelgan.
    [AXEDA_PERMISSIONS.siteManage]: ['global', 'company', 'business'],
    [AXEDA_PERMISSIONS.invitationManage]: ['global', 'company', 'business', 'site'],
    // El personal se crea en una compañía, un negocio o una sede, por quien lo administra ahí.
    [AXEDA_PERMISSIONS.staffManage]: ['global', 'company', 'business', 'site'],
    // Las funcionalidades son de la plataforma (planes, contratos): una compañía no se las enciende.
    [AXEDA_PERMISSIONS.featureManage]: ['global'],
    // El menú de todos (global) o el de una compañía; negocios y sedes heredan el de su compañía.
    [AXEDA_PERMISSIONS.menuManage]: ['global', 'company'],
    [AXEDA_PERMISSIONS.userManage]: ['global'],
    [AXEDA_PERMISSIONS.auditRead]: ['global', 'company'],
  });

export const AXEDA_CATALOG: readonly PermissionKey[] = Object.freeze(
  Object.values(AXEDA_PERMISSIONS),
);
