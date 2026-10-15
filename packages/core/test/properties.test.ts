import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AXEDA_PERMISSION_SCOPES,
  GLOBAL_SCOPE,
  assignmentApplies,
  authorizeGrant,
  covers,
  effectivePermissions,
  parsePermissionKey,
  type AssignmentScope,
  type PermissionKey,
  type Role,
  type RoleAssignment,
  type TargetScope,
} from '../src/index.js';
import { makeAssignment, makeRole, rolesById } from './helpers.js';

const RUNS = { numRuns: 500 };
const NOW = new Date('2026-06-01T12:00:00.000Z');

// "a" y "ab" a propósito: un prefijo de texto no es un prefijo de segmento.
const segment = fc.constantFrom('a', 'ab', 'b');
const concrete = fc.array(segment, { minLength: 2, maxLength: 3 }).map((s) => s.join(':'));
const wildcard = fc
  .array(segment, { minLength: 1, maxLength: 2 })
  .map((s) => [...s, '*'].join(':'));
const anyKey: fc.Arbitrary<PermissionKey> = fc
  .oneof(
    { weight: 4, arbitrary: concrete },
    { weight: 4, arbitrary: wildcard },
    { weight: 1, arbitrary: fc.constant('*') },
  )
  .map(parsePermissionKey);
const concreteKey = concrete.map(parsePermissionKey);

/**
 * Cadena construida a propósito: top ⊒ mid ⊒ concreta, siempre con tres claves distintas
 * (top es `x:*` o el comodín total) para ejercitar de verdad la transitividad.
 */
const coverChain = fc
  .tuple(fc.array(segment, { minLength: 3, maxLength: 3 }), fc.boolean())
  .map(
    ([[x, y, z], total]) =>
      [total ? '*' : `${x}:*`, `${x}:${y}:*`, `${x}:${y}:${z}`].map(parsePermissionKey) as [
        PermissionKey,
        PermissionKey,
        PermissionKey,
      ],
  );

/** Implementación de referencia, escrita de otra forma (por segmentos) para contrastar. */
function referenceCovers(held: string, required: string): boolean {
  const h = held.split(':');
  const r = required.split(':');
  if (h.length === 1 && h[0] === '*') return true;
  if (r.length === 1 && r[0] === '*') return false;
  if (h.at(-1) === '*') {
    const prefix = h.slice(0, -1);
    return r.length > prefix.length && prefix.every((part, index) => r[index] === part);
  }
  return h.length === r.length && h.every((part, index) => r[index] === part);
}

describe('covers: algebraic laws', () => {
  it('is reflexive', () => {
    fc.assert(
      fc.property(anyKey, (key) => covers(key, key)),
      RUNS,
    );
  });

  it('is transitive', () => {
    fc.assert(
      fc.property(
        anyKey,
        anyKey,
        anyKey,
        (a, b, c) => !(covers(a, b) && covers(b, c)) || covers(a, c),
      ),
      { numRuns: 3000 },
    );
  });

  it('is transitive along chains built to cover one another', () => {
    fc.assert(
      fc.property(coverChain, ([a, b, c]) => covers(a, b) && covers(b, c) && covers(a, c)),
      { numRuns: 1000 },
    );
  });

  it('is antisymmetric: mutual coverage means the keys are identical', () => {
    fc.assert(
      fc.property(anyKey, anyKey, (a, b) => !(covers(a, b) && covers(b, a)) || a === b),
      { numRuns: 3000 },
    );
  });

  it('"*" covers everything and is covered only by itself', () => {
    const all = parsePermissionKey('*');
    fc.assert(
      fc.property(anyKey, (key) => covers(all, key) && (key === all || !covers(key, all))),
      RUNS,
    );
  });

  it('a concrete key covers only itself', () => {
    fc.assert(
      fc.property(concreteKey, anyKey, (held, other) => covers(held, other) === (held === other)),
      RUNS,
    );
  });

  it('agrees with an independent segment-based reference implementation', () => {
    fc.assert(
      fc.property(
        anyKey,
        anyKey,
        (held, required) => covers(held, required) === referenceCovers(held, required),
      ),
      {
        numRuns: 5000,
      },
    );
  });

  it('a wildcard never crosses a segment boundary ("a:*" does not cover "ab:x")', () => {
    expect(covers(parsePermissionKey('a:*'), parsePermissionKey('ab:x'))).toBe(false);
    expect(covers(parsePermissionKey('a:*'), parsePermissionKey('a:x'))).toBe(true);
  });
});

// ---------- generadores de escenarios ----------
const targetScopes: TargetScope[] = [
  { type: 'global' },
  { type: 'company', companyId: 'A' },
  { type: 'company', companyId: 'B' },
  { type: 'business', companyId: 'A', businessId: 'A1' },
  { type: 'business', companyId: 'A', businessId: 'A2' },
  { type: 'business', companyId: 'B', businessId: 'B1' },
];
const assignmentScopes: AssignmentScope[] = [
  GLOBAL_SCOPE,
  { type: 'company', id: 'A' },
  { type: 'company', id: 'B' },
  { type: 'business', id: 'A1' },
  { type: 'business', id: 'A2' },
  { type: 'business', id: 'B1' },
];
const roleIds = ['r0', 'r1', 'r2', 'r3'];

// Más peso en negocios y compañías: es donde la herencia hace trabajo.
const target = fc.oneof(
  { weight: 1, arbitrary: fc.constant<TargetScope>({ type: 'global' }) },
  { weight: 2, arbitrary: fc.constantFrom(...targetScopes.filter((t) => t.type === 'company')) },
  { weight: 4, arbitrary: fc.constantFrom(...targetScopes.filter((t) => t.type === 'business')) },
);
const roleArb: fc.Arbitrary<Role> = fc
  .record({
    id: fc.constantFrom(...roleIds),
    permissions: fc.array(anyKey, { minLength: 1, maxLength: 4 }),
    status: fc.constantFrom('active', 'active', 'active', 'inactive' as const),
  })
  .map((r) => makeRole(r));
const rolesArb = fc
  .array(roleArb, { minLength: 1, maxLength: 4 })
  .map((roles) => [...new Map(roles.map((r) => [r.id, r])).values()]);
const assignmentArb: fc.Arbitrary<RoleAssignment> = fc
  .record({
    roleId: fc.constantFrom(...roleIds),
    scope: fc.oneof(
      { weight: 3, arbitrary: fc.constant<AssignmentScope>(GLOBAL_SCOPE) },
      { weight: 5, arbitrary: fc.constantFrom(...assignmentScopes.slice(1)) },
    ),
    expired: fc.constantFrom(false, false, false, true),
    id: fc.uuid(),
  })
  .map(({ id, roleId, scope, expired }) =>
    makeAssignment({
      id,
      roleId,
      scope,
      expiresAt: expired ? new Date(NOW.getTime() - 1) : null,
    }),
  );
const assignmentsArb = fc.array(assignmentArb, { maxLength: 6 });

const compute = (assignments: RoleAssignment[], roles: Role[], at: TargetScope) =>
  effectivePermissions({ assignments, roles: rolesById(...roles), target: at, now: NOW });

describe('effectivePermissions: properties', () => {
  it('only ever contains permissions that some applicable, active, valid role grants', () => {
    fc.assert(
      fc.property(assignmentsArb, rolesArb, target, (assignments, roles, at) => {
        const set = compute(assignments, roles, at);
        const byId = rolesById(...roles);
        const granted = assignments
          .filter(
            (a) => (a.expiresAt === null || a.expiresAt > NOW) && assignmentApplies(a.scope, at),
          )
          .flatMap((a) => {
            const role = byId.get(a.roleId);
            return role?.status === 'active' ? role.permissions : [];
          });
        return (
          set.keys.every((key) => granted.includes(key)) &&
          granted.every((key) => set.keys.includes(key))
        );
      }),
      RUNS,
    );
  });

  it('is monotonic: adding an assignment never removes a permission', () => {
    fc.assert(
      fc.property(
        assignmentsArb,
        assignmentArb,
        rolesArb,
        target,
        anyKey,
        (assignments, extra, roles, at, probe) => {
          const before = compute(assignments, roles, at);
          const after = compute([...assignments, extra], roles, at);
          return !before.allows(probe) || after.allows(probe);
        },
      ),
      RUNS,
    );
  });

  it('does not depend on the order of the assignments', () => {
    fc.assert(
      fc.property(assignmentsArb, rolesArb, target, (assignments, roles, at) => {
        const forward = compute(assignments, roles, at).keys;
        const backward = compute([...assignments].reverse(), roles, at).keys;
        return (
          forward.length === backward.length &&
          forward.every((key, index) => key === backward[index])
        );
      }),
      RUNS,
    );
  });

  it('is deny-by-default: with no assignments nothing is allowed', () => {
    fc.assert(
      fc.property(
        rolesArb,
        target,
        anyKey,
        (roles, at, probe) => !compute([], roles, at).allows(probe),
      ),
      RUNS,
    );
  });

  it('a company assignment applies to every business of that company and nowhere else', () => {
    const businesses = targetScopes.filter((t) => t.type === 'business');
    fc.assert(
      fc.property(
        fc.constantFrom('A', 'B'),
        fc.constantFrom(...businesses),
        (company, business) => {
          if (business.type !== 'business') return true;
          return (
            assignmentApplies({ type: 'company', id: company }, business) ===
            (business.companyId === company)
          );
        },
      ),
      RUNS,
    );
  });

  it('deactivating every role leaves no permissions', () => {
    fc.assert(
      fc.property(assignmentsArb, rolesArb, target, (assignments, roles, at) => {
        const off = roles.map((role) => makeRole({ ...role, status: 'inactive' }));
        return compute(assignments, off, at).keys.length === 0;
      }),
      RUNS,
    );
  });
});

describe('authorizeGrant: properties', () => {
  const scopeTypes = fc.constantFrom('global', 'company', 'business' as const);
  const manage = parsePermissionKey('axeda:assignment:manage');
  const granterArb = fc
    .array(anyKey, { maxLength: 5 })
    .map((held) =>
      compute(
        [makeAssignment({ roleId: 'g', scope: GLOBAL_SCOPE })],
        [makeRole({ id: 'g', permissions: [manage, ...held] })],
        { type: 'global' },
      ),
    );

  it('is sound: an allowed grant never gives more than the granter holds', () => {
    fc.assert(
      fc.property(granterArb, rolesArb, scopeTypes, (granter, roles, scopeType) =>
        roles.every((role) => {
          const decision = authorizeGrant({ granter, role, scopeType });
          return (
            !decision.allowed || (role.status === 'active' && granter.allowsAll(role.permissions))
          );
        }),
      ),
      { numRuns: 1000 },
    );
  });

  it('never lets a role that covers a global-only Axeda permission be granted below global', () => {
    const globalOnly = Object.entries(AXEDA_PERMISSION_SCOPES)
      .filter(([, scopes]) => scopes.length === 1)
      .map(([key]) => parsePermissionKey(key));
    const everything = granterArbWith(['*']);
    fc.assert(
      fc.property(rolesArb, fc.constantFrom('company', 'business' as const), (roles, scopeType) =>
        roles.every((role) => {
          const coversGlobalOnly = globalOnly.some((g) =>
            role.permissions.some((held) => covers(held, g)),
          );
          return (
            !coversGlobalOnly || !authorizeGrant({ granter: everything, role, scopeType }).allowed
          );
        }),
      ),
      { numRuns: 1000 },
    );
  });

  it('denies every grant to someone without the assignment permission', () => {
    const noManage = compute(
      [makeAssignment({ roleId: 'g', scope: GLOBAL_SCOPE })],
      [makeRole({ id: 'g', permissions: [parsePermissionKey('invoice:read')] })],
      { type: 'global' },
    );
    fc.assert(
      fc.property(rolesArb, scopeTypes, (roles, scopeType) =>
        roles.every((role) => !authorizeGrant({ granter: noManage, role, scopeType }).allowed),
      ),
      RUNS,
    );
  });

  it('a total administrator can grant any active role that has no Axeda permission restricted to a wider scope, at global level', () => {
    const root = granterArbWith(['*']);
    fc.assert(
      fc.property(rolesArb, (roles) =>
        roles.every(
          (role) =>
            role.status !== 'active' ||
            authorizeGrant({ granter: root, role, scopeType: 'global' }).allowed,
        ),
      ),
      RUNS,
    );
  });
});

function granterArbWith(held: string[]) {
  return compute(
    [makeAssignment({ roleId: 'g', scope: GLOBAL_SCOPE })],
    [makeRole({ id: 'g', permissions: held.map(parsePermissionKey) })],
    { type: 'global' },
  );
}

describe('the generators are not vacuous', () => {
  it('produce both covering and non-covering pairs', () => {
    const pairs = fc.sample(fc.tuple(anyKey, anyKey), 3000);
    const covering = pairs.filter(([a, b]) => covers(a, b)).length;
    expect(covering).toBeGreaterThan(300);
    expect(covering).toBeLessThan(2700);
  });

  it('build real chains (three distinct keys) for the transitivity property', () => {
    const chains = fc.sample(coverChain, 1000);
    const distinct = chains.filter(([a, b, c]) => a !== b && b !== c).length;
    expect(distinct).toBeGreaterThan(250);
  });

  it('produce scenarios where permissions are actually granted, and where they are not', () => {
    const scenarios = fc.sample(fc.tuple(assignmentsArb, rolesArb, target), 1000);
    const sizes = scenarios.map(
      ([assignments, roles, at]) => compute(assignments, roles, at).keys.length,
    );
    expect(sizes.filter((n) => n > 0).length).toBeGreaterThan(250);
    expect(sizes.filter((n) => n === 0).length).toBeGreaterThan(50);
  });
});
