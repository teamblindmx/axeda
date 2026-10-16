import { describe, expect, it } from 'vitest';
import { isAxedaError, type AxedaErrorCode } from '../src/index.js';
import { createFixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error & { details: Record<string, unknown> };
};

const HOUR = 3_600_000;
const acme = { type: 'company', id: 'A' } as const;

async function world() {
  const f = await createFixture();
  await f.company('A');
  await f.company('B');
  await f.business('a1', 'A');
  await f.role('company-admin', [
    'axeda:invitation:manage',
    'axeda:assignment:manage',
    'invoice:*',
    'report:read',
  ]);
  await f.role('cashier', ['invoice:read', 'invoice:create']);
  await f.role('invoice-god', ['invoice:*', 'axeda:audit:read']);
  await f.role('strict', ['invoice:delete'], { requireMfa: true });
  await f.role('reporter', ['report:read']);
  const boss = f.user('boss');
  await f.give('boss', 'company-admin', acme);
  const roleId = async (key: string) => (await f.persistence.roles.getByKey(key))?.id ?? '';
  /** Quien recibe la invitación: una cuenta con el correo verificado. */
  const guest = (
    id = 'guest',
    extra: { twoFactorEnabled?: boolean; emailVerified?: boolean } = {},
  ) => f.user(id, extra);
  const invite = async (input: Partial<Parameters<typeof f.axeda.invitations.create>[1]> = {}) => {
    const invitation = await f.axeda.invitations.create(boss, {
      email: 'guest@test.dev',
      scope: acme,
      roleIds: [await roleId('cashier')],
      ...input,
    });
    const message = f.sent.at(-1);
    return { invitation, token: message?.token ?? '' };
  };
  return { ...f, boss, roleId, guest, invite };
}

describe('creating invitations', () => {
  it('stores the invitation without the secret and hands the token only to the delivery callback', async () => {
    const w = await world();
    const { invitation, token } = await w.invite();

    expect(invitation).toMatchObject({
      email: 'guest@test.dev',
      scope: acme,
      invitedBy: 'boss',
      acceptedAt: null,
    });
    expect(Object.keys(invitation)).not.toContain('secretHash');
    expect(JSON.stringify(invitation)).not.toContain(token.split('.')[1] ?? 'impossible');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ email: 'guest@test.dev', scope: acme, invitedBy: 'boss' });
    expect(token).toMatch(new RegExp(`^${invitation.id}\\.[A-Za-z0-9_-]{40,}$`));
    // El hash guardado no es el secreto.
    const stored = await w.persistence.invitations.get(invitation.id);
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(stored?.secretHash ?? 'impossible');
  });

  it('expires after the configured time, and a custom ttl is honoured', async () => {
    const w = await world();
    const { invitation } = await w.invite();
    expect(invitation.expiresAt.getTime()).toBe(w.clock.current.getTime() + 72 * HOUR);
    const { invitation: short } = await w.invite({ email: 'other@test.dev', ttlHours: 2 });
    expect(short.expiresAt.getTime()).toBe(w.clock.current.getTime() + 2 * HOUR);
  });

  it('normalizes the email', async () => {
    const w = await world();
    const { invitation } = await w.invite({ email: '  Guest@Test.DEV ' });
    expect(invitation.email).toBe('guest@test.dev');
  });

  it('is idempotent per email and scope: sending again replaces the previous invitation', async () => {
    const w = await world();
    const first = await w.invite();
    const second = await w.invite();
    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect(first.token).not.toBe(second.token);

    w.guest();
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, first.token),
      'AXEDA_INVITATION_INVALID',
    );
    await w.axeda.invitations.accept({ userId: 'guest' }, second.token);
    const pending = await w.axeda.invitations.list(
      w.boss,
      acme,
      { pendingOnly: true },
      { limit: 10 },
    );
    expect(pending.items).toEqual([]);
  });

  it('keeps different scopes and emails apart', async () => {
    const w = await world();
    await w.invite();
    await w.invite({ email: 'else@test.dev' });
    await w.give('boss', 'company-admin', { type: 'business', id: 'a1' });
    await w.invite({ scope: { type: 'business', id: 'a1' } });
    const pending = await w.axeda.invitations.list(
      w.boss,
      acme,
      { pendingOnly: true },
      { limit: 10 },
    );
    expect(pending.items).toHaveLength(2);
  });

  it('needs the invitation permission in that scope, and checks before revealing anything', async () => {
    const w = await world();
    const cashier = w.user('cashierUser');
    await w.give('cashierUser', 'cashier', acme);
    for (const actor of [cashier, w.user('stranger')]) {
      await rejectsWith(
        w.axeda.invitations.create(actor, {
          email: 'x@test.dev',
          scope: acme,
          roleIds: [await w.roleId('cashier')],
        }),
        'AXEDA_FORBIDDEN',
      );
    }
    // fuera de su compañía
    await rejectsWith(
      w.axeda.invitations.create(w.boss, {
        email: 'x@test.dev',
        scope: { type: 'company', id: 'B' },
        roleIds: [await w.roleId('cashier')],
      }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      w.axeda.invitations.create(w.boss, {
        email: 'x@test.dev',
        scope: GLOBAL,
        roleIds: [await w.roleId('cashier')],
      }),
      'AXEDA_FORBIDDEN',
    );
    expect(w.sent).toEqual([]);
  });

  it('is governed by the invitation permission, not the assignment one (in both directions)', async () => {
    const w = await world();
    await w.role('inviter-only', ['axeda:invitation:manage', 'invoice:read']);
    await w.role('assigner-only', ['axeda:assignment:manage', 'invoice:read']);
    const inviter = w.user('inviterOnly');
    const assigner = w.user('assignerOnly');
    await w.give('inviterOnly', 'inviter-only', acme);
    await w.give('assignerOnly', 'assigner-only', acme);
    const input = { email: 'x@test.dev', scope: acme, roleIds: [await w.roleId('cashier')] };

    // cajero cubre invoice:read e invoice:create; quien invita solo tiene invoice:read → no puede
    const readerId = (await w.role('reader-only', ['invoice:read'])).id;
    const readerInput = { ...input, roleIds: [readerId] };
    const created = await w.axeda.invitations.create(inviter, readerInput);
    expect(created.invitedBy).toBe('inviterOnly');
    // y al aceptar, se vuelve a comprobar con el mismo permiso: sigue valiendo
    w.users.add({ id: 'x', email: 'x@test.dev' });
    expect(
      await w.axeda.invitations.accept({ userId: 'x' }, w.sent.at(-1)?.token ?? ''),
    ).toHaveLength(1);

    // quien solo puede ASIGNAR no puede INVITAR
    await rejectsWith(w.axeda.invitations.create(assigner, readerInput), 'AXEDA_FORBIDDEN');
  });

  it('applies the no-escalation rule: only roles the inviter fully holds', async () => {
    const w = await world();
    const error = await rejectsWith(
      w.axeda.invitations.create(w.boss, {
        email: 'x@test.dev',
        scope: acme,
        roleIds: [await w.roleId('invoice-god')],
      }),
      'AXEDA_FORBIDDEN',
    );
    expect(error.details['reason']).toBe('exceeds_granter_permissions');
    expect(w.sent).toEqual([]);
  });

  it('validates the input', async () => {
    const w = await world();
    const bad = (input: unknown) => w.axeda.invitations.create(w.boss, input as never);
    const roleIds = [await w.roleId('cashier')];
    await rejectsWith(bad({ email: 'not-an-email', scope: acme, roleIds }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(
      bad({ email: 'a@test.dev', scope: acme, roleIds: [] }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ email: 'a@test.dev', scope: acme, roleIds, ttlHours: 0 }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ email: 'a@test.dev', scope: acme, roleIds, extra: true }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ email: 'a@test.dev', scope: acme, roleIds: ['nope'] }),
      'AXEDA_ROLE_NOT_FOUND',
    );
    await rejectsWith(
      bad({ email: 'a@test.dev', scope: { type: 'company', id: 'ghost' }, roleIds }),
      'AXEDA_FORBIDDEN',
    );
  });

  it('is disabled when no delivery is configured', async () => {
    const f = await createFixture(undefined, { invitations: false });
    await f.company('A');
    const role = await f.role('r', ['invoice:read']);
    await rejectsWith(
      f.axeda.invitations.create(f.admin, { email: 'a@test.dev', scope: acme, roleIds: [role.id] }),
      'AXEDA_FEATURE_DISABLED',
    );
  });

  it('reports a delivery failure but keeps the invitation, so it can be resent', async () => {
    const w = await world();
    w.failDelivery.on = true;
    await rejectsWith(w.invite(), 'AXEDA_DELIVERY_FAILED');
    const stuck = await w.axeda.invitations.list(
      w.boss,
      acme,
      { pendingOnly: true },
      { limit: 10 },
    );
    expect(stuck.items).toHaveLength(1);

    w.failDelivery.on = false;
    const { invitation, token } = await w.invite();
    const pending = await w.axeda.invitations.list(
      w.boss,
      acme,
      { pendingOnly: true },
      { limit: 10 },
    );
    expect(pending.items.map((item) => item.id)).toEqual([invitation.id]);
    w.guest();
    expect(await w.axeda.invitations.accept({ userId: 'guest' }, token)).toHaveLength(1);
  });
});

const GLOBAL = { type: 'global' } as const;

describe('accepting invitations', () => {
  it('creates the assignments for the account that owns the verified email, and audits it', async () => {
    const w = await world();
    const { token, invitation } = await w.invite({ roleIds: [await w.roleId('cashier')] });
    w.guest();
    const created = await w.axeda.invitations.accept({ userId: 'guest' }, token);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: 'guest', scope: acme, grantedBy: 'boss' });
    expect(
      await w.axeda.can({ userId: 'guest' }, 'invoice:create', { type: 'company', companyId: 'A' }),
    ).toBe(true);
    expect(await w.axeda.can({ userId: 'guest' }, 'invoice:create')).toBe(false);

    const events = await w.axeda.listAudit(w.admin, { action: 'invitation.accept' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({
      actorId: 'guest',
      targetId: invitation.id,
      outcome: 'success',
    });
  });

  it('works once: a second use of the same token fails', async () => {
    const w = await world();
    const { token } = await w.invite();
    w.guest();
    await w.axeda.invitations.accept({ userId: 'guest' }, token);
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, token),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('lets exactly one of several simultaneous acceptances win', async () => {
    const w = await world();
    const { token } = await w.invite();
    w.guest();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => w.axeda.invitations.accept({ userId: 'guest' }, token)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await w.persistence.assignments.countForUser('guest')).toBe(1);
  });

  it('refuses a different account, even with the right token (a stolen link is useless)', async () => {
    const w = await world();
    const { token } = await w.invite();
    w.user('mallory');
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'mallory' }, token),
      'AXEDA_INVITATION_INVALID',
    );
    expect(await w.persistence.assignments.countForUser('mallory')).toBe(0);
    // y la invitación sigue pendiente para su dueño
    w.guest();
    await w.axeda.invitations.accept({ userId: 'guest' }, token);
  });

  it('refuses an account whose email is not verified (someone could register the victim’s address)', async () => {
    const w = await world();
    const { token } = await w.invite();
    w.guest('guest', { emailVerified: false });
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, token),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('refuses garbage, forged and wrong tokens with one indistinguishable answer', async () => {
    const w = await world();
    const { token, invitation } = await w.invite();
    w.guest();
    const [id] = token.split('.');
    const attempts = [
      '',
      'nonsense',
      `${id}.`,
      '.secret',
      `${id}.wrong-secret`,
      `nope.${token.split('.')[1]}`,
      'a.b.c.d',
      'x'.repeat(600),
      `${invitation.id}.${'0'.repeat(43)}`,
    ];
    const messages = new Set<string>();
    for (const attempt of attempts) {
      const error = await rejectsWith(
        w.axeda.invitations.accept({ userId: 'guest' }, attempt),
        'AXEDA_INVITATION_INVALID',
      );
      messages.add(error.message);
    }
    expect(messages.size).toBe(1);
    expect(await w.persistence.assignments.countForUser('guest')).toBe(0);
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, 42 as never),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('refuses an expired invitation, at the expiry instant itself', async () => {
    const w = await world();
    const { token, invitation } = await w.invite();
    w.guest();
    w.clock.current = new Date(invitation.expiresAt.getTime() - 1);
    const ok = await w.axeda.invitations.accept({ userId: 'guest' }, token);
    expect(ok).toHaveLength(1);

    const second = await w.invite({ email: 'late@test.dev' });
    w.user('late', {});
    w.users.add({ id: 'late', email: 'late@test.dev' });
    w.clock.current = second.invitation.expiresAt;
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'late' }, second.token),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('refuses a revoked invitation', async () => {
    const w = await world();
    const { token, invitation } = await w.invite();
    await w.axeda.invitations.revoke(w.boss, invitation.id);
    w.guest();
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, token),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('re-checks the inviter’s CURRENT power: if they lost it, the invitation is worthless', async () => {
    const w = await world();
    const { token } = await w.invite();
    const bossAssignment = (await w.persistence.assignments.listForUser('boss'))[0];
    await w.axeda.assignments.revoke(w.admin, bossAssignment?.id ?? '');
    w.guest();
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, token),
      'AXEDA_INVITATION_INVALID',
    );
    expect(await w.persistence.assignments.countForUser('guest')).toBe(0);
    const denied = await w.axeda.listAudit(w.admin, { action: 'invitation.accept' }, { limit: 5 });
    expect(denied.items[0]).toMatchObject({ outcome: 'denied' });
  });

  it('is void if the inviter is banned or deleted, if the role disappears, or if the company is inactive', async () => {
    const w = await world();
    w.guest();

    const a = await w.invite();
    w.users.add({ id: 'boss', banned: true });
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, a.token),
      'AXEDA_INVITATION_INVALID',
    );
    w.users.add({ id: 'boss', banned: false });

    const cashier = await w.persistence.roles.getByKey('cashier');
    const b = await w.invite({ email: 'guest@test.dev' });
    await w.axeda.roles.delete(w.admin, cashier?.id ?? '');
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, b.token),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('is void when the company has been deactivated', async () => {
    const w = await world();
    const { token } = await w.invite();
    await w.axeda.companies.setStatus(w.admin, 'A', 1, 'inactive');
    w.guest();
    await rejectsWith(
      w.axeda.invitations.accept({ userId: 'guest' }, token),
      'AXEDA_INVITATION_INVALID',
    );
  });

  it('requires two-factor authentication for roles that ask for it, and leaves the invitation usable', async () => {
    const w = await world();
    const { token } = await w.invite({ roleIds: [await w.roleId('strict')] });
    w.guest('guest', { twoFactorEnabled: false });
    await rejectsWith(w.axeda.invitations.accept({ userId: 'guest' }, token), 'AXEDA_MFA_REQUIRED');
    expect(await w.persistence.assignments.countForUser('guest')).toBe(0);

    // La invitación no se gastó: al activar el 2FA se puede aceptar.
    w.users.add({ id: 'guest', twoFactorEnabled: true });
    const ok = await w.axeda.invitations.accept({ userId: 'guest', twoFactorEnabled: true }, token);
    expect(ok).toHaveLength(1);
  });

  it('skips roles the person already has and respects the assignment limit', async () => {
    const w = await world();
    const cashierId = await w.roleId('cashier');
    w.guest();
    await w.axeda.assignments.assign(w.admin, { userId: 'guest', roleId: cashierId, scope: acme });
    const { token } = await w.invite();
    expect(await w.axeda.invitations.accept({ userId: 'guest' }, token)).toEqual([]);
    expect(await w.persistence.assignments.countForUser('guest')).toBe(1);

    const tight = await createFixture({
      permissions: ['a:b'],
      limits: { maxAssignmentsPerUser: 1 },
    });
    await tight.company('A');
    const role = await tight.role('r', ['a:b']);
    tight.user('g1');
    await tight.axeda.assignments.assign(tight.admin, {
      userId: 'g1',
      roleId: role.id,
      scope: GLOBAL,
    });
    await tight.axeda.invitations.create(tight.admin, {
      email: 'g1@test.dev',
      scope: acme,
      roleIds: [role.id],
    });
    await rejectsWith(
      tight.axeda.invitations.accept({ userId: 'g1' }, tight.sent.at(-1)?.token ?? ''),
      'AXEDA_LIMIT_EXCEEDED',
    );
  });

  it('can grant several roles at once', async () => {
    const w = await world();
    const { token } = await w.invite({
      roleIds: [await w.roleId('cashier'), await w.roleId('reporter')],
    });
    w.guest();
    const created = await w.axeda.invitations.accept({ userId: 'guest' }, token);
    expect(created).toHaveLength(2);
    expect(
      await w.axeda.can({ userId: 'guest' }, 'report:read', { type: 'company', companyId: 'A' }),
    ).toBe(true);
  });
});

describe('listing and revoking', () => {
  it('lists the invitations of a scope only to someone who manages it, never with secrets', async () => {
    const w = await world();
    await w.invite();
    const page = await w.axeda.invitations.list(
      w.boss,
      acme,
      { pendingOnly: false },
      { limit: 10 },
    );
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page.items)).not.toMatch(/secret|hash/i);
    await rejectsWith(
      w.axeda.invitations.list(w.boss, { type: 'company', id: 'B' }, {}, { limit: 10 }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      w.axeda.invitations.list(w.user('stranger'), acme, {}, { limit: 10 }),
      'AXEDA_FORBIDDEN',
    );
  });

  it('revokes an invitation, audits it, and answers "not found" to people with no authority', async () => {
    const w = await world();
    const { invitation } = await w.invite();
    await rejectsWith(
      w.axeda.invitations.revoke(w.user('stranger'), invitation.id),
      'AXEDA_INVITATION_INVALID',
    );
    await rejectsWith(w.axeda.invitations.revoke(w.boss, 'nope'), 'AXEDA_INVITATION_INVALID');
    await w.axeda.invitations.revoke(w.boss, invitation.id);
    expect((await w.persistence.invitations.get(invitation.id))?.revokedAt).not.toBeNull();
    await rejectsWith(
      w.axeda.invitations.revoke(w.boss, invitation.id),
      'AXEDA_INVITATION_INVALID',
    );
    const events = await w.axeda.listAudit(w.admin, { targetId: invitation.id }, { limit: 10 });
    expect(events.items.map((e) => `${e.action}:${e.outcome}`).sort()).toEqual([
      'invitation.create:success',
      'invitation.revoke:denied',
      'invitation.revoke:success',
    ]);
  });
});
