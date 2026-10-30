import { describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_SCOPE,
  isAxedaError,
  type AssignmentScope,
  type AxedaErrorCode,
} from '../src/index.js';
import { createFixture, type Fixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error & { details: Record<string, unknown> };
};

const companyA: AssignmentScope = { type: 'company', id: 'A' };
const companyB: AssignmentScope = { type: 'company', id: 'B' };

/** Una compañía A con su administrador, un cajero y funciones de ejemplo. */
async function scenario() {
  const f = await createFixture();
  await f.company('A');
  await f.company('B');
  await f.role('company-admin', ['axeda:assignment:manage', 'invoice:*']);
  await f.role('cashier', ['invoice:read', 'invoice:create']);
  await f.role('invoice-god', ['invoice:*', 'report:read']);
  await f.role('role-admin', ['axeda:role:manage']);
  const boss = f.user('boss');
  f.user('alice');
  await f.give('boss', 'company-admin', companyA);
  return {
    ...f,
    boss,
    roleId: async (key: string) => (await f.persistence.roles.getByKey(key))?.id ?? '',
  };
}

describe('assign: who can grant what', () => {
  it('lets a company admin assign within their company, and the user gets the permissions there only', async () => {
    const f = await scenario();
    const created = await f.axeda.assignments.assign(f.boss, {
      userId: 'alice',
      roleId: await f.roleId('cashier'),
      scope: companyA,
    });
    expect(created).toMatchObject({ userId: 'alice', grantedBy: 'boss', scope: companyA });

    const alice = { userId: 'alice' };
    expect(await f.axeda.can(alice, 'invoice:create', { type: 'company', companyId: 'A' })).toBe(
      true,
    );
    expect(await f.axeda.can(alice, 'invoice:create', { type: 'company', companyId: 'B' })).toBe(
      false,
    );
    expect(await f.axeda.can(alice, 'invoice:create')).toBe(false);
  });

  it('refuses scopes outside the actor’s own: another company and global', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    for (const scope of [companyB, GLOBAL_SCOPE]) {
      const error = await rejectsWith(
        f.axeda.assignments.assign(f.boss, { userId: 'alice', roleId, scope }),
        'AXEDA_FORBIDDEN',
      );
      expect(error.details['reason']).toBe('missing_assignment_permission');
    }
  });

  it('refuses a role with more permissions than the actor holds (no escalation)', async () => {
    const f = await scenario();
    const error = await rejectsWith(
      f.axeda.assignments.assign(f.boss, {
        userId: 'alice',
        roleId: await f.roleId('invoice-god'),
        scope: companyA,
      }),
      'AXEDA_FORBIDDEN',
    );
    expect(error.details['reason']).toBe('exceeds_granter_permissions');
    expect(error.details['permissions']).toEqual(['report:read']);
  });

  it('refuses to grant Axeda permissions outside the scopes where they are valid', async () => {
    const f = await scenario();
    // boss tiene assignment:manage en A, pero role:manage solo vale en global.
    const error = await rejectsWith(
      f.axeda.assignments.assign(f.boss, {
        userId: 'alice',
        roleId: await f.roleId('role-admin'),
        scope: companyA,
      }),
      'AXEDA_FORBIDDEN',
    );
    expect(['exceeds_granter_permissions', 'permission_not_valid_in_scope']).toContain(
      error.details['reason'],
    );
  });

  it('keeps "*" global-only even for the global administrator', async () => {
    const f = await scenario();
    const rootId = (await f.persistence.roles.getByKey('super-admin'))?.id ?? '';
    const error = await rejectsWith(
      f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId: rootId, scope: companyA }),
      'AXEDA_FORBIDDEN',
    );
    expect(error.details['reason']).toBe('permission_not_valid_in_scope');
  });

  it('refuses an inactive role', async () => {
    const f = await scenario();
    const cashier = await f.persistence.roles.getByKey('cashier');
    await f.axeda.roles.setStatus(f.admin, cashier?.id ?? '', cashier?.version ?? 0, 'inactive');
    const error = await rejectsWith(
      f.axeda.assignments.assign(f.boss, {
        userId: 'alice',
        roleId: cashier?.id ?? '',
        scope: companyA,
      }),
      'AXEDA_FORBIDDEN',
    );
    expect(error.details['reason']).toBe('role_inactive');
  });

  it('audits denials separately from the rolled-back attempt, and leaves nothing behind', async () => {
    const f = await scenario();
    await rejectsWith(
      f.axeda.assignments.assign(f.boss, {
        userId: 'alice',
        roleId: await f.roleId('invoice-god'),
        scope: companyA,
      }),
      'AXEDA_FORBIDDEN',
    );
    expect(await f.persistence.assignments.listForUser('alice')).toEqual([]);
    const denied = await f.axeda.listAudit(
      f.admin,
      { actorId: 'boss', action: 'assignment.create' },
      { limit: 5 },
    );
    expect(denied.items).toHaveLength(1);
    expect(denied.items[0]).toMatchObject({
      outcome: 'denied',
      scope: companyA,
      metadata: { reason: 'exceeds_granter_permissions' },
    });
  });

  it('records the grant in the audit log with who, what and where', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    const created = await f.axeda.assignments.assign(
      { ...f.boss, ip: '203.0.113.9', userAgent: 'test-agent' },
      { userId: 'alice', roleId, scope: companyA },
    );
    const [event] = (await f.axeda.listAudit(f.admin, { targetId: created.id }, { limit: 5 }))
      .items;
    expect(event).toMatchObject({
      actorId: 'boss',
      action: 'assignment.create',
      outcome: 'success',
      scope: companyA,
      ip: '203.0.113.9',
      userAgent: 'test-agent',
      metadata: { userId: 'alice', roleId, roleKey: 'cashier' },
    });
  });
});

describe('assign: validation and limits', () => {
  it('rejects an unknown user or role', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    await rejectsWith(
      f.axeda.assignments.assign(f.admin, { userId: 'ghost', roleId, scope: GLOBAL_SCOPE }),
      'AXEDA_USER_NOT_FOUND',
    );
    await rejectsWith(
      f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId: 'nope', scope: GLOBAL_SCOPE }),
      'AXEDA_ROLE_NOT_FOUND',
    );
  });

  it('rejects malformed input and unknown fields', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    const bad = (input: unknown) => f.axeda.assignments.assign(f.admin, input as never);
    await rejectsWith(bad({ userId: '', roleId, scope: GLOBAL_SCOPE }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      bad({ userId: 'alice', roleId, scope: { type: 'planet', id: 'x' } }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ userId: 'alice', roleId, scope: { type: 'company' } }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ userId: 'alice', roleId, scope: GLOBAL_SCOPE, grantedBy: 'x' }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(bad(null), 'AXEDA_INVALID_INPUT');
  });

  it('rejects an expiry in the past, and honours a future one', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    await rejectsWith(
      f.axeda.assignments.assign(f.admin, {
        userId: 'alice',
        roleId,
        scope: GLOBAL_SCOPE,
        expiresAt: new Date(f.clock.current.getTime() - 1),
      }),
      'AXEDA_INVALID_INPUT',
    );
    await f.axeda.assignments.assign(f.admin, {
      userId: 'alice',
      roleId,
      scope: GLOBAL_SCOPE,
      expiresAt: new Date(f.clock.current.getTime() + 3_600_000),
    });
    const alice = { userId: 'alice' };
    expect(await f.axeda.can(alice, 'invoice:read')).toBe(true);
    f.clock.current = new Date(f.clock.current.getTime() + 3_600_000);
    expect(await f.axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('rejects a duplicate assignment', async () => {
    const f = await scenario();
    const input = { userId: 'alice', roleId: await f.roleId('cashier'), scope: GLOBAL_SCOPE };
    await f.axeda.assignments.assign(f.admin, input);
    await rejectsWith(f.axeda.assignments.assign(f.admin, input), 'AXEDA_ASSIGNMENT_EXISTS');
  });

  it('enforces the assignment limit per user', async () => {
    const f = await createFixture({
      permissions: ['a:b'],
      limits: { maxAssignmentsPerUser: 2 },
    });
    await f.role('r', ['a:b']);
    f.user('alice');
    for (const id of ['1', '2', '3']) await f.company(id);
    const roleId = (await f.persistence.roles.getByKey('r'))?.id ?? '';
    for (const id of ['1', '2']) {
      await f.axeda.assignments.assign(f.admin, {
        userId: 'alice',
        roleId,
        scope: { type: 'company', id },
      });
    }
    await rejectsWith(
      f.axeda.assignments.assign(f.admin, {
        userId: 'alice',
        roleId,
        scope: { type: 'company', id: '3' },
      }),
      'AXEDA_LIMIT_EXCEEDED',
    );
  });
});

describe('assign: roles that require MFA', () => {
  it('refuses to assign them to a user without two-factor authentication', async () => {
    const f = await createFixture();
    const strict = await f.role('strict', ['invoice:delete'], { requireMfa: true });
    f.user('alice');
    f.user('bob', { twoFactorEnabled: true });
    await rejectsWith(
      f.axeda.assignments.assign(f.admin, {
        userId: 'alice',
        roleId: strict.id,
        scope: GLOBAL_SCOPE,
      }),
      'AXEDA_MFA_REQUIRED',
    );
    await f.axeda.assignments.assign(f.admin, {
      userId: 'bob',
      roleId: strict.id,
      scope: GLOBAL_SCOPE,
    });
  });

  it('grants nothing at decision time if the user later loses two-factor authentication', async () => {
    const f = await createFixture();
    const strict = await f.role('strict', ['invoice:delete'], { requireMfa: true });
    f.user('bob', { twoFactorEnabled: true });
    await f.axeda.assignments.assign(f.admin, {
      userId: 'bob',
      roleId: strict.id,
      scope: GLOBAL_SCOPE,
    });
    expect(await f.axeda.can({ userId: 'bob', twoFactorEnabled: true }, 'invoice:delete')).toBe(
      true,
    );
    expect(await f.axeda.can({ userId: 'bob', twoFactorEnabled: false }, 'invoice:delete')).toBe(
      false,
    );
    expect(await f.axeda.can({ userId: 'bob' }, 'invoice:delete')).toBe(false);
  });

  it('does not count an MFA-gated admin role of the actor when the actor lacks MFA', async () => {
    const f = await createFixture();
    await f.company('A');
    await f.role('mfa-admin', ['axeda:assignment:manage', 'invoice:read'], { requireMfa: true });
    await f.role('viewer', ['invoice:read']);
    f.user('target');
    await f.axeda.assignments.assign(f.admin, {
      userId: (f.user('boss', { twoFactorEnabled: true }), 'boss'),
      roleId: (await f.persistence.roles.getByKey('mfa-admin'))?.id ?? '',
      scope: companyA,
    });
    const viewerId = (await f.persistence.roles.getByKey('viewer'))?.id ?? '';
    const input = { userId: 'target', roleId: viewerId, scope: companyA };

    await rejectsWith(
      f.axeda.assignments.assign({ userId: 'boss', twoFactorEnabled: false }, input),
      'AXEDA_FORBIDDEN',
    );
    await f.axeda.assignments.assign({ userId: 'boss', twoFactorEnabled: true }, input);
  });
});

describe('revoke', () => {
  async function granted(f: Fixture, scope: AssignmentScope = companyA) {
    const roleId = (await f.persistence.roles.getByKey('cashier'))?.id ?? '';
    return f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId, scope });
  }

  it('lets the company admin revoke inside their company and audits it', async () => {
    const f = await scenario();
    const assignment = await granted(f);
    await f.axeda.assignments.revoke(f.boss, assignment.id);
    expect(await f.persistence.assignments.get(assignment.id)).toBeNull();
    expect(
      await f.axeda.can({ userId: 'alice' }, 'invoice:read', { type: 'company', companyId: 'A' }),
    ).toBe(false);
    const events = await f.axeda.listAudit(f.admin, { action: 'assignment.revoke' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({
      actorId: 'boss',
      targetId: assignment.id,
      outcome: 'success',
    });
  });

  it('answers "not found" when the actor has no authority over that scope (404, not 403)', async () => {
    const f = await scenario();
    const inB = await granted(f, companyB);
    const missing = await rejectsWith(
      f.axeda.assignments.revoke(f.boss, inB.id),
      'AXEDA_ASSIGNMENT_NOT_FOUND',
    );
    const unknown = await rejectsWith(
      f.axeda.assignments.revoke(f.boss, 'nope'),
      'AXEDA_ASSIGNMENT_NOT_FOUND',
    );
    expect(missing.message.replace(inB.id, 'X')).toBe(unknown.message.replace('nope', 'X'));
    expect(await f.persistence.assignments.get(inB.id)).not.toBeNull();
    // El intento queda en la auditoría aunque la respuesta lo disfrace.
    const denied = await f.axeda.listAudit(
      f.admin,
      { actorId: 'boss', action: 'assignment.revoke' },
      { limit: 5 },
    );
    expect(denied.items[0]).toMatchObject({ outcome: 'denied' });
  });

  it('refuses to revoke a more powerful assignment inside the same scope (403)', async () => {
    const f = await scenario();
    const roleId = await f.roleId('invoice-god');
    const strong = await f.axeda.assignments.assign(f.admin, {
      userId: 'alice',
      roleId,
      scope: companyA,
    });
    const error = await rejectsWith(
      f.axeda.assignments.revoke(f.boss, strong.id),
      'AXEDA_FORBIDDEN',
    );
    expect(error.details['reason']).toBe('exceeds_granter_permissions');
    expect(await f.persistence.assignments.get(strong.id)).not.toBeNull();
  });

  it('can revoke the assignment of a role that has since been deactivated', async () => {
    const f = await scenario();
    const assignment = await granted(f);
    const cashier = await f.persistence.roles.getByKey('cashier');
    await f.axeda.roles.setStatus(f.admin, cashier?.id ?? '', cashier?.version ?? 0, 'inactive');
    await f.axeda.assignments.revoke(f.boss, assignment.id);
    expect(await f.persistence.assignments.get(assignment.id)).toBeNull();
  });

  it('a revoked granter immediately loses the ability to grant', async () => {
    const f = await scenario();
    const bossAssignment = (await f.persistence.assignments.listForUser('boss'))[0];
    const roleId = await f.roleId('cashier');
    const input = { userId: 'alice', roleId, scope: companyA };
    await f.axeda.assignments.assign(f.boss, input); // funciona
    await f.axeda.assignments.revoke(f.admin, bossAssignment?.id ?? '');
    await rejectsWith(
      f.axeda.assignments.assign(f.boss, { ...input, userId: 'admin' }),
      'AXEDA_FORBIDDEN',
    );
  });

  it('takes the version lock on both users, in order, before reading permissions', async () => {
    const f = await scenario();
    const locked: string[] = [];
    const original = f.persistence.transaction.bind(f.persistence);
    vi.spyOn(f.persistence, 'transaction').mockImplementation((callback) =>
      original((stores) =>
        callback({
          ...stores,
          authz: {
            ...stores.authz,
            bumpUserVersion: (userId) => {
              locked.push(userId);
              return stores.authz.bumpUserVersion(userId);
            },
          },
        }),
      ),
    );
    const roleId = await f.roleId('cashier');
    await f.axeda.assignments.assign(f.boss, { userId: 'alice', roleId, scope: companyA });
    // Orden alfabético y sin repetir: así dos concesiones cruzadas no se bloquean entre sí.
    expect(locked).toEqual(['alice', 'boss']);
  });
});

describe('business scopes', () => {
  async function withBusinesses() {
    const f = await scenario();
    await f.business('b1', 'A');
    await f.business('b2', 'B');
    return f;
  }

  it('are rejected when the business does not exist', async () => {
    const f = await scenario();
    await rejectsWith(
      f.axeda.assignments.assign(f.admin, {
        userId: 'alice',
        roleId: await f.roleId('cashier'),
        scope: { type: 'business', id: 'nope' },
      }),
      'AXEDA_INVALID_INPUT',
    );
  });

  it('take the company from the database, so a company admin manages only their own businesses', async () => {
    const f = await withBusinesses();
    const roleId = await f.roleId('cashier');
    await f.axeda.assignments.assign(f.boss, {
      userId: 'alice',
      roleId,
      scope: { type: 'business', id: 'b1' },
    });
    await rejectsWith(
      f.axeda.assignments.assign(f.boss, {
        userId: 'alice',
        roleId,
        scope: { type: 'business', id: 'b2' },
      }),
      'AXEDA_FORBIDDEN',
    );
    const ghost = { userId: 'alice', roleId, scope: { type: 'business', id: 'ghost' } } as const;
    // Quien no administra a nivel global no puede distinguir "no existe" de "no puedes".
    await rejectsWith(f.axeda.assignments.assign(f.boss, ghost), 'AXEDA_FORBIDDEN');
    await rejectsWith(f.axeda.assignments.assign(f.admin, ghost), 'AXEDA_INVALID_INPUT');
  });

  it('see a company admin through to the businesses of their company when listing', async () => {
    const f = await withBusinesses();
    const roleId = await f.roleId('cashier');
    await f.axeda.assignments.assign(f.admin, {
      userId: 'alice',
      roleId,
      scope: { type: 'business', id: 'b1' },
    });
    await f.axeda.assignments.assign(f.admin, {
      userId: 'alice',
      roleId,
      scope: { type: 'business', id: 'b2' },
    });
    const seen = await f.axeda.assignments.listForUser(f.boss, 'alice');
    expect(seen.map((item) => item.scope)).toEqual([{ type: 'business', id: 'b1' }]);
  });

  it('does not reveal whether a user exists to someone who cannot manage the scope', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    const outsider = f.user('outsider');
    for (const userId of ['alice', 'ghost-user']) {
      await rejectsWith(
        f.axeda.assignments.assign(outsider, { userId, roleId, scope: companyA }),
        'AXEDA_FORBIDDEN',
      );
    }
    await rejectsWith(
      f.axeda.assignments.assign(outsider, {
        userId: 'alice',
        roleId: 'no-such-role',
        scope: companyA,
      }),
      'AXEDA_FORBIDDEN',
    );
  });
});

describe('listing assignments', () => {
  it('shows a user their own assignments and admins only the scopes they manage', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    await f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId, scope: companyA });
    await f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId, scope: companyB });
    await f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId, scope: GLOBAL_SCOPE });

    const own = await f.axeda.assignments.listForUser({ userId: 'alice' }, 'alice');
    expect(own).toHaveLength(3);

    const seenByBoss = await f.axeda.assignments.listForUser(f.boss, 'alice');
    expect(seenByBoss.map((a) => a.scope)).toEqual([companyA]);

    const seenByStranger = await f.axeda.assignments.listForUser(f.user('stranger'), 'alice');
    expect(seenByStranger).toEqual([]);

    expect(await f.axeda.assignments.listForUser(f.admin, 'alice')).toHaveLength(3);
  });

  it('lists a scope only to someone who manages it', async () => {
    const f = await scenario();
    const roleId = await f.roleId('cashier');
    await f.axeda.assignments.assign(f.admin, { userId: 'alice', roleId, scope: companyA });
    const page = await f.axeda.assignments.listForScope(f.boss, companyA, { limit: 10 });
    expect(page.items.map((a) => a.userId).sort()).toEqual(['alice', 'boss']);
    await rejectsWith(
      f.axeda.assignments.listForScope(f.boss, companyB, { limit: 10 }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      f.axeda.assignments.listForScope(f.boss, GLOBAL_SCOPE, { limit: 10 }),
      'AXEDA_FORBIDDEN',
    );
  });
});
