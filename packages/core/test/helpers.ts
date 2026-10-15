import {
  parsePermissionKey,
  type AssignmentScope,
  type PermissionKey,
  type Role,
  type RoleAssignment,
} from '../src/index.js';

export const k = parsePermissionKey;
export const keys = (...raw: string[]): PermissionKey[] => raw.map(parsePermissionKey);

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

export function makeRole(overrides: Partial<Role> & { id: string }): Role {
  return {
    key: overrides.id,
    name: overrides.id,
    description: null,
    permissions: [],
    requireMfa: false,
    status: 'active',
    managed: false,
    version: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function makeAssignment(
  overrides: Partial<RoleAssignment> & { roleId: string; scope: AssignmentScope },
): RoleAssignment {
  return {
    id: `a-${overrides.roleId}-${overrides.scope.type}`,
    userId: 'u1',
    grantedBy: null,
    createdAt: EPOCH,
    expiresAt: null,
    ...overrides,
  };
}

export const rolesById = (...roles: Role[]): ReadonlyMap<string, Role> =>
  new Map(roles.map((role) => [role.id, role]));
