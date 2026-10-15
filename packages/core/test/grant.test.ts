import { describe, expect, it } from 'vitest';
import {
  AXEDA_PERMISSIONS,
  GLOBAL_SCOPE,
  authorizeGrant,
  effectivePermissions,
  type PermissionSet,
  type ScopeType,
  type TargetScope,
} from '../src/index.js';
import { keys, makeAssignment, makeRole, rolesById } from './helpers.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

/** Permisos de un usuario cuyas asignaciones son `granted`, calculados en `target`. */
function holder(
  target: TargetScope,
  granted: Array<{
    role: ReturnType<typeof makeRole>;
    scope: Parameters<typeof makeAssignment>[0]['scope'];
  }>,
): PermissionSet {
  return effectivePermissions({
    assignments: granted.map(({ role, scope }) => makeAssignment({ roleId: role.id, scope })),
    roles: rolesById(...granted.map(({ role }) => role)),
    target,
    now: NOW,
  });
}

const companyA: TargetScope = { type: 'company', companyId: 'A' };
const manage = AXEDA_PERMISSIONS.assignmentManage;

const cashier = makeRole({ id: 'cashier', permissions: keys('invoice:create', 'invoice:read') });
const viewer = makeRole({ id: 'viewer', permissions: keys('invoice:read') });
const superAdmin = makeRole({ id: 'super', permissions: keys('*') });
const companyAdmin = makeRole({ id: 'cadmin', permissions: [manage, ...keys('invoice:*')] });

const decide = (granter: PermissionSet, role: ReturnType<typeof makeRole>, scopeType: ScopeType) =>
  authorizeGrant({ granter, role, scopeType });

describe('authorizeGrant (no privilege escalation)', () => {
  it('lets a global administrator grant any role at global level', () => {
    const granter = holder({ type: 'global' }, [{ role: superAdmin, scope: GLOBAL_SCOPE }]);
    expect(decide(granter, cashier, 'global')).toEqual({ allowed: true });
    expect(decide(granter, superAdmin, 'global')).toEqual({ allowed: true });
  });

  it('lets a company administrator grant roles within their own permissions', () => {
    const granter = holder(companyA, [{ role: companyAdmin, scope: { type: 'company', id: 'A' } }]);
    expect(decide(granter, cashier, 'company')).toEqual({ allowed: true });
    expect(decide(granter, viewer, 'business')).toEqual({ allowed: true });
  });

  it('denies a role with more permissions than the granter holds', () => {
    const limited = makeRole({ id: 'limited', permissions: [manage, ...keys('invoice:read')] });
    const granter = holder(companyA, [{ role: limited, scope: { type: 'company', id: 'A' } }]);
    expect(decide(granter, cashier, 'company')).toEqual({
      allowed: false,
      reason: 'exceeds_granter_permissions',
      permissions: keys('invoice:create'),
    });
  });

  it('covers a concrete permission with a wildcard, but not the other way round', () => {
    const wide = holder(companyA, [
      {
        role: makeRole({ id: 'w', permissions: [manage, ...keys('invoice:*')] }),
        scope: { type: 'company', id: 'A' },
      },
    ]);
    const narrow = holder(companyA, [
      {
        role: makeRole({ id: 'n', permissions: [manage, ...keys('invoice:read')] }),
        scope: { type: 'company', id: 'A' },
      },
    ]);
    const wildcardRole = makeRole({ id: 'wild', permissions: keys('invoice:*') });
    expect(decide(wide, viewer, 'company').allowed).toBe(true);
    expect(decide(narrow, wildcardRole, 'company')).toMatchObject({
      allowed: false,
      reason: 'exceeds_granter_permissions',
      permissions: keys('invoice:*'),
    });
  });

  it('denies a granter without the assignment permission', () => {
    const granter = holder({ type: 'global' }, [{ role: cashier, scope: GLOBAL_SCOPE }]);
    expect(decide(granter, viewer, 'global')).toMatchObject({
      allowed: false,
      reason: 'missing_assignment_permission',
    });
  });

  it('denies an inactive role', () => {
    const granter = holder({ type: 'global' }, [{ role: superAdmin, scope: GLOBAL_SCOPE }]);
    const inactive = makeRole({ ...cashier, status: 'inactive' });
    expect(decide(granter, inactive, 'global')).toMatchObject({
      allowed: false,
      reason: 'role_inactive',
    });
  });

  it('denies granting a role that manages roles outside the global scope', () => {
    const granter = holder(companyA, [
      { role: makeRole({ id: 'x', permissions: keys('*') }), scope: GLOBAL_SCOPE },
    ]);
    const roleAdmin = makeRole({ id: 'roleadmin', permissions: [AXEDA_PERMISSIONS.roleManage] });
    expect(decide(granter, roleAdmin, 'company')).toEqual({
      allowed: false,
      reason: 'permission_not_valid_in_scope',
      permissions: [AXEDA_PERMISSIONS.roleManage],
    });
    expect(decide(granter, roleAdmin, 'global').allowed).toBe(true);
  });

  it('keeps the total wildcard "*" global-only, even for a global administrator', () => {
    const granter = holder(companyA, [{ role: superAdmin, scope: GLOBAL_SCOPE }]);
    const denied = decide(granter, superAdmin, 'company');
    expect(denied).toMatchObject({ allowed: false, reason: 'permission_not_valid_in_scope' });
    expect(decide(granter, superAdmin, 'business')).toMatchObject({ allowed: false });
  });

  it('keeps "axeda:*" global-only as well, but allows an application wildcard in a company', () => {
    const granter = holder(companyA, [{ role: superAdmin, scope: GLOBAL_SCOPE }]);
    const axedaWildcard = makeRole({ id: 'aw', permissions: keys('axeda:*') });
    const appWildcard = makeRole({ id: 'app', permissions: keys('invoice:*') });
    expect(decide(granter, axedaWildcard, 'company').allowed).toBe(false);
    expect(decide(granter, appWildcard, 'company').allowed).toBe(true);
  });

  it('allows axeda permissions in the scopes where they are valid', () => {
    const granter = holder(companyA, [{ role: superAdmin, scope: GLOBAL_SCOPE }]);
    const assignmentAdmin = makeRole({
      id: 'aa',
      permissions: [AXEDA_PERMISSIONS.assignmentManage],
    });
    const auditor = makeRole({ id: 'au', permissions: [AXEDA_PERMISSIONS.auditRead] });
    expect(decide(granter, assignmentAdmin, 'business').allowed).toBe(true);
    expect(decide(granter, auditor, 'company').allowed).toBe(true);
    expect(decide(granter, auditor, 'business').allowed).toBe(false);
  });

  it('does not let a company administrator grant at global level or in another company', () => {
    const assignments = [{ role: companyAdmin, scope: { type: 'company', id: 'A' } } as const];
    const atGlobal = holder({ type: 'global' }, [...assignments]);
    const atCompanyB = holder({ type: 'company', companyId: 'B' }, [...assignments]);
    expect(decide(atGlobal, viewer, 'global')).toMatchObject({
      reason: 'missing_assignment_permission',
    });
    expect(decide(atCompanyB, viewer, 'company')).toMatchObject({
      reason: 'missing_assignment_permission',
    });
  });

  it('does not let a business administrator grant for the whole company', () => {
    const bizAdmin = makeRole({ id: 'badmin', permissions: [manage, ...keys('invoice:*')] });
    const assignments = [{ role: bizAdmin, scope: { type: 'business', id: 'A1' } } as const];
    const atBusiness = holder({ type: 'business', companyId: 'A', businessId: 'A1' }, [
      ...assignments,
    ]);
    const atCompany = holder(companyA, [...assignments]);
    expect(decide(atBusiness, viewer, 'business').allowed).toBe(true);
    expect(decide(atCompany, viewer, 'company')).toMatchObject({
      reason: 'missing_assignment_permission',
    });
  });
});
