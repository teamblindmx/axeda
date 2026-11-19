import { z } from 'zod';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { AuditAction } from '../domain/audit.js';
import type { Actor, RequestMeta, Role } from '../domain/role.js';
import type { AssignmentScope, TargetScope } from '../domain/scope.js';
import {
  PIN_PATTERN,
  STAFF_EMAIL_DOMAIN,
  USERNAME_PATTERN,
  generatePin,
  homeScopeOf,
  isWeakPin,
  normalizeUsername,
  type StaffAccount,
  type StoredStaffAccount,
} from '../domain/staff.js';
import { AxedaError } from '../errors.js';
import { authorizeGrant } from '../policy/grant.js';
import type { UserAdmin } from '../ports/identity.js';
import type { Page, PageRequest } from '../ports/paging.js';
import type { AxedaStores } from '../ports/persistence.js';
import type { PinHasher } from '../ports/staff.js';
import { auditDenials, markDenied, writeAudit, type AuditDraft } from './audit.js';
import {
  actorPermissions,
  lockUsers,
  resolveForActor,
  resolveTarget,
  type Services,
} from './services.js';
import { parseInput } from './tenant-input.js';

export interface StaffInput {
  /** Dónde trabaja: una compañía, un negocio o una sede. */
  readonly scope: AssignmentScope;
  readonly username: string;
  /** El nombre que se muestra. */
  readonly name: string;
  /** Funciones que se le asignan en ese mismo lugar (sin permisos de Axeda). */
  readonly roleIds?: readonly string[] | undefined;
}

/** Una cuenta de personal con lo que se muestra de su usuario. */
export interface StaffMember extends StaffAccount {
  readonly name: string;
  readonly banned: boolean;
}

export interface StaffSignIn {
  /** El slug de la compañía. */
  readonly company: string;
  readonly username: string;
  readonly pin: string;
}

export interface StaffService {
  /** Crea la cuenta con un PIN aleatorio, que se devuelve **una sola vez**. */
  create(actor: Actor, input: StaffInput): Promise<{ member: StaffMember; pin: string }>;
  /** El personal de ese lugar y de lo que tiene debajo. */
  list(actor: Actor, scope: AssignmentScope, page: PageRequest): Promise<Page<StaffMember>>;
  get(actor: Actor, userId: string): Promise<StaffMember>;
  rename(actor: Actor, userId: string, username: string): Promise<StaffMember>;
  /** PIN nuevo (devuelto una sola vez): desbloquea la cuenta y cierra sus sesiones. */
  resetPin(actor: Actor, userId: string): Promise<{ pin: string }>;
  unlock(actor: Actor, userId: string): Promise<StaffMember>;
  /** No puede entrar y se cierran sus sesiones, hasta `reactivate`. */
  suspend(actor: Actor, userId: string): Promise<StaffMember>;
  reactivate(actor: Actor, userId: string): Promise<StaffMember>;
  remove(actor: Actor, userId: string): Promise<void>;
  /** La propia persona cambia su PIN dando el actual. */
  changePin(actor: Actor, input: { currentPin: string; newPin: string }): Promise<void>;
  /**
   * Comprueba usuario y PIN. Para cualquier fallo lanza el mismo `AXEDA_STAFF_SIGN_IN_FAILED`,
   * sin decir si la compañía o el usuario existen. Abrir la sesión le toca al sistema de identidad.
   */
  signIn(input: StaffSignIn, meta?: RequestMeta): Promise<{ readonly userId: string }>;
}

const id = z.string().min(1).max(255);
const createSchema = (maxRoles: number) =>
  z.strictObject({
    scope: z.strictObject({ type: z.enum(['company', 'business', 'site']), id }),
    username: z
      .string()
      .transform(normalizeUsername)
      .pipe(
        z
          .string()
          .regex(USERNAME_PATTERN, 'must be 3 to 32 lowercase letters, digits, ".", "-" or "_"'),
      ),
    name: z.string().trim().min(1).max(200),
    roleIds: z.array(id).max(maxRoles).optional(),
  });
const usernameSchema = createSchema(1).shape.username;

/** Lo más que dura un bloqueo, por muchos que lleve seguidos: un día. */
const MAX_LOCK_MS = 24 * 60 * 60_000;

const signInFailed = (): AxedaError =>
  new AxedaError('AXEDA_STAFF_SIGN_IN_FAILED', 'Wrong company, username or PIN.');

const randomEmail = (): string =>
  `${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}@${STAFF_EMAIL_DOMAIN}`;

/** La compañía, el negocio y la sede de una cuenta nueva, del lugar ya resuelto en la base de datos. */
function homeOf(target: TargetScope): {
  companyId: string;
  businessId: string | null;
  siteId: string | null;
} {
  if (target.type === 'global')
    throw new AxedaError('AXEDA_INVALID_INPUT', 'Staff belong to a company.');
  if (target.type === 'company')
    return { companyId: target.companyId, businessId: null, siteId: null };
  if (target.type === 'business') {
    return { companyId: target.companyId, businessId: target.businessId, siteId: null };
  }
  return { companyId: target.companyId, businessId: target.businessId, siteId: target.siteId };
}

export function createStaffService(services: Services): StaffService {
  const { persistence, options } = services;
  const limits = options.staff;
  const policy = {
    maxAttempts: limits.maxAttempts,
    lockMs: limits.lockMinutes * 60_000,
    maxLockMs: MAX_LOCK_MS,
  };
  let dummyHash: Promise<string> | undefined;

  function deps(): {
    hasher: PinHasher;
    admin: UserAdmin & { delete: NonNullable<UserAdmin['delete']> };
  } {
    const admin = services.userAdmin;
    if (services.pinHasher === undefined || admin?.delete === undefined) {
      throw new AxedaError(
        'AXEDA_FEATURE_DISABLED',
        'Staff accounts are disabled: they need a PIN hasher and a user administration that can delete users.',
      );
    }
    return {
      hasher: services.pinHasher,
      admin: admin as UserAdmin & { delete: NonNullable<UserAdmin['delete']> },
    };
  }

  const hidden = (userId: string): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_STAFF_NOT_FOUND', `Staff account "${userId}" does not exist.`, {
        details: { reason: 'not_visible' },
      }),
    );

  const draft = (
    actor: Actor | null,
    action: AuditAction,
    targetId: string | null,
    scope: AssignmentScope | null,
    metadata: Record<string, unknown> = {},
  ): AuditDraft => ({
    actorId: actor?.userId ?? null,
    action,
    targetType: 'user',
    targetId,
    scope,
    meta: actor ?? undefined,
    metadata,
  });

  const mayManage = async (stores: AxedaStores, actor: Actor, target: TargetScope) =>
    (await actorPermissions(stores, services, actor, target)).allows(AXEDA_PERMISSIONS.staffManage);

  async function member(account: StaffAccount): Promise<StaffMember> {
    const user = await deps().admin.get(account.userId);
    return { ...account, name: user?.name ?? '', banned: user?.banned ?? false };
  }

  /**
   * La cuenta, si quien actúa la administra. Si no, lo mismo que si no existiera. No escribe nada.
   */
  async function visible(
    actor: Actor,
    userId: string,
  ): Promise<{ account: StoredStaffAccount; target: TargetScope }> {
    await services.ready();
    deps();
    const account = typeof userId === 'string' ? await persistence.staff.get(userId) : null;
    if (account === null) throw hidden(String(userId));
    const target = await resolveTarget(services, homeScopeOf(account), {
      requireUsable: false,
    }).catch(() => null);
    if (target === null || !(await mayManage(persistence, actor, target))) throw hidden(userId);
    return { account, target };
  }

  /**
   * Un cambio sobre una cuenta: se autoriza, se hace `work` en una transacción que vuelve a
   * comprobar el permiso, y se audita. Las denegaciones también quedan en la auditoría.
   */
  async function record<T>(
    actor: Actor,
    userId: string,
    action: AuditAction,
    work: (stores: AxedaStores, account: StoredStaffAccount) => Promise<T>,
    before?: (account: StoredStaffAccount) => Promise<void>,
  ): Promise<T> {
    const base = draft(actor, action, userId, null);
    return auditDenials(persistence, base, async () => {
      const { account, target } = await visible(actor, userId);
      // Efectos fuera de la base de datos (bloquear, cerrar sesiones): antes de registrar el éxito.
      if (before !== undefined) await before(account);
      return persistence.transaction(async (stores) => {
        if (!(await mayManage(stores, actor, target))) throw hidden(userId);
        const fresh = await stores.staff.get(userId);
        if (fresh === null) throw hidden(userId);
        await lockUsers(stores, [actor.userId, userId]);
        const result = await work(stores, fresh);
        await writeAudit(stores, { ...base, scope: homeScopeOf(fresh) }, 'success');
        return result;
      });
    });
  }

  /** Las funciones que se dan al crear la cuenta, con las reglas de siempre, en su lugar. */
  async function grantRoles(
    stores: AxedaStores,
    actor: Actor,
    target: TargetScope,
    scope: AssignmentScope,
    userId: string,
    roleIds: readonly string[],
  ): Promise<void> {
    const granter = await actorPermissions(stores, services, actor, target);
    for (const roleId of [...new Set(roleIds)]) {
      const role: Role | null = await stores.roles.get(roleId);
      if (role === null)
        throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${roleId}" does not exist.`);
      if (role.requireMfa) {
        throw new AxedaError(
          'AXEDA_MFA_REQUIRED',
          `Role "${role.key}" requires two-factor authentication, which a staff account cannot have.`,
        );
      }
      const decision = authorizeGrant({
        granter,
        role,
        scopeType: scope.type,
        via: AXEDA_PERMISSIONS.staffManage,
        grantee: { pinAccount: true },
      });
      if (!decision.allowed) {
        throw markDenied(
          new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to give that role.', {
            details: { reason: decision.reason, permissions: decision.permissions },
          }),
        );
      }
      await stores.assignments.create({ userId, roleId, scope, grantedBy: actor.userId });
    }
  }

  /** El PIN se compara siempre, exista o no la cuenta: no se distingue por el tiempo. */
  async function burnTime(hasher: PinHasher, pin: string): Promise<void> {
    dummyHash ??= hasher.hash(generatePin());
    await hasher.verify(pin, await dummyHash);
  }

  /** Bien formado: textos, y un PIN de 6 a 8 dígitos. */
  const wellFormed = (input: StaffSignIn): boolean =>
    typeof input?.company === 'string' &&
    typeof input.username === 'string' &&
    typeof input.pin === 'string' &&
    PIN_PATTERN.test(input.pin);

  /** Puede entrar: su compañía, negocio y sede activos y sin borrar, y su usuario sin bloquear. */
  async function mayEnter(account: StoredStaffAccount): Promise<boolean> {
    const usable = await resolveTarget(services, homeScopeOf(account)).then(
      () => true,
      () => false,
    );
    const user = await services.users.find(account.userId);
    return usable && user !== null && !user.banned;
  }

  async function findForSignIn(input: StaffSignIn): Promise<StoredStaffAccount | null> {
    if (!wellFormed(input)) return null;
    const company = await persistence.companies.getBySlug(input.company.trim().toLowerCase());
    if (company === null) return null;
    const account = await persistence.staff.findByUsername(
      company.id,
      normalizeUsername(input.username),
    );
    return account !== null && (await mayEnter(account)) ? account : null;
  }

  return {
    async create(actor, input) {
      await services.ready();
      const { hasher, admin } = deps();
      const base = draft(actor, 'staff.create', null, input?.scope ?? null);
      return auditDenials(persistence, base, async () => {
        const target = await resolveForActor(services, persistence, actor, input?.scope, {
          permission: AXEDA_PERMISSIONS.staffManage,
          onDenied: () =>
            markDenied(
              new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to manage staff here.', {
                details: { reason: 'missing_staff_permission' },
              }),
            ),
        });
        if (!(await mayManage(persistence, actor, target))) {
          throw markDenied(
            new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to manage staff here.', {
              details: { reason: 'missing_staff_permission' },
            }),
          );
        }
        const parsed = parseInput(createSchema(options.invitations.maxRoles), input);
        const home = homeOf(target);
        if ((await persistence.staff.findByUsername(home.companyId, parsed.username)) !== null) {
          throw new AxedaError(
            'AXEDA_USERNAME_TAKEN',
            'That username is already used in this company.',
          );
        }
        const pin = generatePin(limits.pinLength);
        const pinHash = await hasher.hash(pin);
        const user = await admin.create({ email: randomEmail(), name: parsed.name });
        try {
          const account = await persistence.transaction(async (stores) => {
            if (!(await mayManage(stores, actor, target)))
              throw new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to manage staff here.');
            await lockUsers(stores, [actor.userId, user.id]);
            const created = await stores.staff.create({
              userId: user.id,
              ...home,
              username: parsed.username,
              pinHash,
              createdBy: actor.userId,
            });
            await grantRoles(stores, actor, target, parsed.scope, user.id, parsed.roleIds ?? []);
            await writeAudit(
              stores,
              draft(actor, 'staff.create', user.id, parsed.scope, {
                username: parsed.username,
                roleIds: parsed.roleIds ?? [],
              }),
              'success',
            );
            return created;
          });
          return { member: { ...account, name: user.name, banned: false }, pin };
        } catch (error) {
          // Sin su cuenta de personal, el usuario recién creado no sirve: se borra.
          await admin.delete(user.id).catch(() => undefined);
          throw error;
        }
      });
    },

    async list(actor, scope, page) {
      await services.ready();
      deps();
      const denied = () =>
        new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to see the staff here.');
      if (scope?.type === 'global') throw denied();
      const target = await resolveForActor(services, persistence, actor, scope, {
        permission: AXEDA_PERMISSIONS.staffManage,
        onDenied: denied,
        requireUsable: false,
      });
      if (!(await mayManage(persistence, actor, target))) throw denied();
      const home = homeOf(target);
      const result = await persistence.staff.list(
        {
          companyId: home.companyId,
          ...(target.type === 'business' ? { businessId: home.businessId ?? undefined } : {}),
          ...(target.type === 'site' ? { siteId: home.siteId ?? undefined } : {}),
        },
        page,
      );
      return { items: await Promise.all(result.items.map(member)), nextCursor: result.nextCursor };
    },

    async get(actor, userId) {
      return member((await visible(actor, userId)).account);
    },

    async rename(actor, userId, username) {
      const parsed = parseInput(usernameSchema, username);
      return member(
        await record(actor, userId, 'staff.update', (stores) =>
          stores.staff.rename(userId, parsed),
        ),
      );
    },

    async resetPin(actor, userId) {
      const { hasher, admin } = deps();
      const pin = generatePin(limits.pinLength);
      const pinHash = await hasher.hash(pin);
      await record(actor, userId, 'staff.reset_pin', (stores) =>
        stores.staff.setPin(userId, pinHash, services.clock.now()),
      );
      // Quien tuviera el PIN anterior deja de estar dentro.
      await admin.revokeSessions(userId);
      return { pin };
    },

    async unlock(actor, userId) {
      return member(
        await record(actor, userId, 'staff.unlock', async (stores, found) => {
          await stores.staff.resetAttempts(userId);
          return { ...found, failedAttempts: 0, lockedUntil: null, lockCount: 0 };
        }),
      );
    },

    async suspend(actor, userId) {
      const { admin } = deps();
      const account = await record(
        actor,
        userId,
        'staff.suspend',
        async (_stores, found) => found,
        async () => {
          await admin.setBan(userId, { reason: null, expiresAt: null });
          await admin.revokeSessions(userId);
        },
      );
      return member(account);
    },

    async reactivate(actor, userId) {
      const { admin } = deps();
      const account = await record(
        actor,
        userId,
        'staff.reactivate',
        async (_stores, found) => found,
        async () => {
          await admin.setBan(userId, null);
        },
      );
      return member(account);
    },

    async remove(actor, userId) {
      const { admin } = deps();
      await record(actor, userId, 'staff.remove', (stores) => stores.staff.delete(userId));
      // El usuario se borra después: sin su cuenta de personal ya no puede entrar.
      await admin.delete(userId);
    },

    async changePin(actor, input) {
      await services.ready();
      const { hasher } = deps();
      const account = await persistence.staff.get(actor.userId);
      if (account === null) {
        throw new AxedaError('AXEDA_STAFF_NOT_FOUND', 'Only staff accounts have a PIN.');
      }
      const newPin = typeof input?.newPin === 'string' ? input.newPin : '';
      if (!PIN_PATTERN.test(newPin) || isWeakPin(newPin) || newPin === input.currentPin) {
        throw new AxedaError(
          'AXEDA_INVALID_INPUT',
          'newPin must be 6 to 8 digits, not easy to guess and not the current one.',
        );
      }
      // Cambiar el PIN también gasta intentos: no sirve para probar PINs sin límite.
      const wrong = () =>
        markDenied(
          new AxedaError('AXEDA_FORBIDDEN', 'The current PIN is wrong.', {
            details: { reason: 'wrong_pin' },
          }),
        );
      await auditDenials(
        persistence,
        draft(actor, 'staff.change_pin', actor.userId, null),
        async () => {
          if (
            (await persistence.staff.consumeAttempt(actor.userId, services.clock.now(), policy)) ===
            'locked'
          ) {
            throw wrong();
          }
          if (
            typeof input.currentPin !== 'string' ||
            !(await hasher.verify(input.currentPin, account.pinHash))
          ) {
            throw wrong();
          }
          const pinHash = await hasher.hash(newPin);
          await persistence.transaction(async (stores) => {
            await stores.staff.setPin(actor.userId, pinHash, services.clock.now());
            await writeAudit(
              stores,
              draft(actor, 'staff.change_pin', actor.userId, homeScopeOf(account)),
              'success',
            );
          });
        },
      );
    },

    async signIn(input, meta) {
      await services.ready();
      const { hasher } = deps();
      const pin = typeof input?.pin === 'string' ? input.pin : '';
      const account = await findForSignIn(input);
      if (account === null) {
        await burnTime(hasher, pin);
        throw signInFailed();
      }
      const audit = (outcome: 'success' | 'denied', reason?: string) =>
        writeAudit(
          persistence,
          {
            ...draft(
              null,
              'staff.sign_in',
              account.userId,
              homeScopeOf(account),
              reason ? { reason } : {},
            ),
            actorId: account.userId,
            meta,
          },
          outcome,
        );
      if (
        (await persistence.staff.consumeAttempt(account.userId, services.clock.now(), policy)) ===
        'locked'
      ) {
        await burnTime(hasher, pin);
        await audit('denied', 'locked');
        throw signInFailed();
      }
      if (!(await hasher.verify(pin, account.pinHash))) {
        await audit('denied', 'wrong_pin');
        throw signInFailed();
      }
      await persistence.staff.resetAttempts(account.userId);
      await audit('success');
      return { userId: account.userId };
    },
  };
}
