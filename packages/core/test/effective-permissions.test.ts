import { describe, expect, it } from 'vitest';
import {
  EMPTY_PERMISSIONS,
  GLOBAL_SCOPE,
  effectivePermissions,
  type TargetScope,
} from '../src/index.js';
import { k, keys, makeAssignment, makeRole, rolesById } from './helpers.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const global: TargetScope = { type: 'global' };
const businessA1: TargetScope = { type: 'business', companyId: 'A', businessId: 'A1' };

const cashier = makeRole({ id: 'cashier', permissions: keys('invoice:create', 'invoice:read') });
const viewer = makeRole({ id: 'viewer', permissions: keys('invoice:read', 'report:read') });

describe('effectivePermissions', () => {
  it('denies everything by default', () => {
    const set = effectivePermissions({
      assignments: [],
      roles: rolesById(),
      target: global,
      now: NOW,
    });
    expect(set.keys).toEqual([]);
    expect(set.allows(k('invoice:read'))).toBe(false);
    expect(EMPTY_PERMISSIONS.allows(k('invoice:read'))).toBe(false);
  });

  it('unions the permissions of every applicable role, without duplicates', () => {
    const set = effectivePermissions({
      assignments: [
        makeAssignment({ roleId: 'cashier', scope: GLOBAL_SCOPE }),
        makeAssignment({ roleId: 'viewer', scope: GLOBAL_SCOPE }),
      ],
      roles: rolesById(cashier, viewer),
      target: global,
      now: NOW,
    });
    expect(set.keys).toEqual(keys('invoice:create', 'invoice:read', 'report:read'));
  });

  it('only counts assignments that apply to the target scope', () => {
    const assignments = [
      makeAssignment({ roleId: 'cashier', scope: { type: 'company', id: 'A' } }),
      makeAssignment({ roleId: 'viewer', scope: { type: 'company', id: 'B' } }),
    ];
    const set = effectivePermissions({
      assignments,
      roles: rolesById(cashier, viewer),
      target: businessA1,
      now: NOW,
    });
    expect(set.allows(k('invoice:create'))).toBe(true);
    expect(set.allows(k('report:read'))).toBe(false);
  });

  it('gives a company-level role no power at global level', () => {
    const set = effectivePermissions({
      assignments: [makeAssignment({ roleId: 'cashier', scope: { type: 'company', id: 'A' } })],
      roles: rolesById(cashier),
      target: global,
      now: NOW,
    });
    expect(set.keys).toEqual([]);
  });

  it('ignores inactive roles (revocation by deactivating the role)', () => {
    const inactive = makeRole({ ...cashier, status: 'inactive' });
    const set = effectivePermissions({
      assignments: [makeAssignment({ roleId: 'cashier', scope: GLOBAL_SCOPE })],
      roles: rolesById(inactive),
      target: global,
      now: NOW,
    });
    expect(set.keys).toEqual([]);
  });

  it('ignores assignments whose role no longer exists', () => {
    const set = effectivePermissions({
      assignments: [makeAssignment({ roleId: 'ghost', scope: GLOBAL_SCOPE })],
      roles: rolesById(cashier),
      target: global,
      now: NOW,
    });
    expect(set.keys).toEqual([]);
  });

  it('ignores expired assignments, treating the expiry instant itself as expired', () => {
    const base = { roleId: 'cashier', scope: GLOBAL_SCOPE } as const;
    const run = (expiresAt: Date | null) =>
      effectivePermissions({
        assignments: [makeAssignment({ ...base, expiresAt })],
        roles: rolesById(cashier),
        target: global,
        now: NOW,
      }).keys.length;
    expect(run(new Date(NOW.getTime() - 1))).toBe(0);
    expect(run(NOW)).toBe(0);
    expect(run(new Date(NOW.getTime() + 1))).toBe(2);
    expect(run(null)).toBe(2);
  });

  it('applies wildcards held by a role', () => {
    const admin = makeRole({ id: 'admin', permissions: keys('invoice:*') });
    const set = effectivePermissions({
      assignments: [makeAssignment({ roleId: 'admin', scope: GLOBAL_SCOPE })],
      roles: rolesById(admin),
      target: global,
      now: NOW,
    });
    expect(set.allows(k('invoice:delete'))).toBe(true);
    expect(set.allows(k('order:delete'))).toBe(false);
  });

  describe('roles that require MFA', () => {
    const strict = makeRole({ id: 'strict', permissions: keys('invoice:*'), requireMfa: true });
    const plain = makeRole({ id: 'plain', permissions: keys('report:read') });
    const run = (mfaEnabled: boolean | undefined, extra: Partial<typeof strict> = {}) =>
      effectivePermissions({
        assignments: [
          makeAssignment({ roleId: 'strict', scope: GLOBAL_SCOPE }),
          makeAssignment({ roleId: 'plain', scope: GLOBAL_SCOPE }),
        ],
        roles: rolesById(makeRole({ ...strict, ...extra }), plain),
        target: global,
        now: NOW,
        mfaEnabled,
      });

    it('grants their permissions only when the user has MFA enabled', () => {
      expect(run(true).allows(k('invoice:read'))).toBe(true);
      expect(run(false).allows(k('invoice:read'))).toBe(false);
    });

    it('denies when the MFA state is unknown', () => {
      expect(run(undefined).allows(k('invoice:read'))).toBe(false);
    });

    it('only withholds the permissions of that role, not the rest', () => {
      expect(run(false).keys).toEqual(keys('report:read'));
    });

    it('does not need MFA for roles that do not ask for it', () => {
      expect(run(false, { requireMfa: false }).allows(k('invoice:read'))).toBe(true);
    });
  });
});

describe('PermissionSet', () => {
  it('lists the permissions it does not cover', () => {
    const set = effectivePermissions({
      assignments: [makeAssignment({ roleId: 'viewer', scope: GLOBAL_SCOPE })],
      roles: rolesById(viewer),
      target: global,
      now: NOW,
    });
    const wanted = keys('invoice:read', 'invoice:create', 'report:*');
    expect(set.missing(wanted)).toEqual(keys('invoice:create', 'report:*'));
    expect(set.allowsAll(keys('invoice:read', 'report:read'))).toBe(true);
    expect(set.allowsAll(wanted)).toBe(false);
  });

  it('is immutable', () => {
    const set = effectivePermissions({
      assignments: [],
      roles: rolesById(),
      target: global,
      now: NOW,
    });
    expect(Object.isFrozen(set.keys)).toBe(true);
  });
});
