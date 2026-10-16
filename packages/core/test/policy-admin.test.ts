import { describe, expect, it } from 'vitest';
import {
  AXEDA_PERMISSIONS,
  GLOBAL_SCOPE,
  authorizeRevoke,
  authorizeRoleChange,
  permissionsHeldAnywhere,
  scopeContains,
  scopesGranting,
  effectivePermissions,
  type AssignmentScope,
} from '../src/index.js';
import { k, keys, makeAssignment, makeRole, rolesById } from './helpers.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const companyA: AssignmentScope = { type: 'company', id: 'A' };

const held = (...raw: string[]) =>
  effectivePermissions({
    assignments: [makeAssignment({ roleId: 'r', scope: GLOBAL_SCOPE })],
    roles: rolesById(makeRole({ id: 'r', permissions: keys(...raw) })),
    target: { type: 'global' },
    now: NOW,
  });

describe('authorizeRevoke', () => {
  const cashier = makeRole({ id: 'cashier', permissions: keys('invoice:read', 'invoice:create') });

  it('allows an actor who manages assignments and covers the role', () => {
    const granter = held('axeda:assignment:manage', 'invoice:*');
    expect(authorizeRevoke({ granter, role: cashier })).toEqual({ allowed: true });
  });

  it('denies without axeda:assignment:manage, reporting that as "missing"', () => {
    expect(authorizeRevoke({ granter: held('invoice:*'), role: cashier })).toMatchObject({
      allowed: false,
      reason: 'missing_assignment_permission',
    });
  });

  it('denies revoking a role stronger than the actor, and says which permissions', () => {
    const granter = held('axeda:assignment:manage', 'invoice:read');
    expect(authorizeRevoke({ granter, role: cashier })).toEqual({
      allowed: false,
      reason: 'exceeds_granter_permissions',
      permissions: keys('invoice:create'),
    });
  });

  it('does not care whether the role is active (a deactivated role can be revoked)', () => {
    const granter = held('axeda:assignment:manage', 'invoice:*');
    expect(
      authorizeRevoke({ granter, role: makeRole({ ...cashier, status: 'inactive' }) }).allowed,
    ).toBe(true);
  });
});

describe('authorizeRoleChange', () => {
  it('denies without axeda:role:manage', () => {
    expect(authorizeRoleChange({ actor: held('invoice:*'), added: [] })).toMatchObject({
      allowed: false,
      reason: 'missing_role_permission',
    });
  });

  it('allows removing permissions (nothing added) with only axeda:role:manage', () => {
    expect(authorizeRoleChange({ actor: held(AXEDA_PERMISSIONS.roleManage), added: [] })).toEqual({
      allowed: true,
    });
  });

  it('allows adding what the actor holds and denies the rest', () => {
    const actor = held(AXEDA_PERMISSIONS.roleManage, 'invoice:read');
    expect(authorizeRoleChange({ actor, added: keys('invoice:read') }).allowed).toBe(true);
    expect(authorizeRoleChange({ actor, added: keys('invoice:read', 'invoice:delete') })).toEqual({
      allowed: false,
      reason: 'exceeds_actor_permissions',
      permissions: keys('invoice:delete'),
    });
  });

  it('does not let a limited actor add a wildcard', () => {
    const actor = held(AXEDA_PERMISSIONS.roleManage, 'invoice:read');
    expect(authorizeRoleChange({ actor, added: keys('*') }).allowed).toBe(false);
    expect(authorizeRoleChange({ actor, added: keys('invoice:*') }).allowed).toBe(false);
  });
});

describe('permissionsHeldAnywhere and scopesGranting', () => {
  const reader = makeRole({ id: 'reader', permissions: keys('invoice:read') });
  const strict = makeRole({ id: 'strict', permissions: keys('report:read'), requireMfa: true });
  const data = {
    assignments: [
      makeAssignment({ id: 'a1', roleId: 'reader', scope: companyA }),
      makeAssignment({ id: 'a2', roleId: 'reader', scope: { type: 'business', id: 'b1' } }),
      makeAssignment({ id: 'a3', roleId: 'strict', scope: companyA }),
    ],
    roles: rolesById(reader, strict),
    now: NOW,
  };

  it('unions the permissions of every live assignment, ignoring the scope', () => {
    expect(permissionsHeldAnywhere(data).keys).toEqual(keys('invoice:read'));
    expect(permissionsHeldAnywhere({ ...data, mfaEnabled: true }).keys).toEqual(
      keys('invoice:read', 'report:read'),
    );
  });

  it('returns each granting scope once', () => {
    expect(scopesGranting(data, k('invoice:read'))).toEqual([
      companyA,
      { type: 'business', id: 'b1' },
    ]);
    expect(scopesGranting(data, k('invoice:delete'))).toEqual([]);
    expect(scopesGranting(data, k('report:read'))).toEqual([]);
  });

  it('skips expired assignments and inactive roles', () => {
    const expired = {
      ...data,
      assignments: [makeAssignment({ roleId: 'reader', scope: companyA, expiresAt: NOW })],
    };
    expect(scopesGranting(expired, k('invoice:read'))).toEqual([]);
    const off = { ...data, roles: rolesById(makeRole({ ...reader, status: 'inactive' }), strict) };
    expect(permissionsHeldAnywhere(off).keys).toEqual([]);
  });
});

describe('scopeContains', () => {
  const business: AssignmentScope = { type: 'business', id: 'b1' };

  it('global contains everything', () => {
    for (const inner of [GLOBAL_SCOPE, companyA, business]) {
      expect(scopeContains(GLOBAL_SCOPE, inner)).toBe(true);
    }
  });

  it('a scope contains itself and nothing sideways', () => {
    expect(scopeContains(companyA, companyA)).toBe(true);
    expect(scopeContains(companyA, { type: 'company', id: 'B' })).toBe(false);
    expect(scopeContains(business, business)).toBe(true);
    expect(scopeContains(business, { type: 'business', id: 'b2' })).toBe(false);
    expect(scopeContains(companyA, GLOBAL_SCOPE)).toBe(false);
    expect(scopeContains(business, companyA)).toBe(false);
  });

  it('a company contains its businesses only when their company is known', () => {
    expect(scopeContains(companyA, business)).toBe(false);
    expect(scopeContains(companyA, business, 'A')).toBe(true);
    expect(scopeContains(companyA, business, 'B')).toBe(false);
  });
});
