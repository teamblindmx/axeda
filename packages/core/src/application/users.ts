import { z } from 'zod';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { AuditAction } from '../domain/audit.js';
import type { Actor } from '../domain/role.js';
import { GLOBAL_SCOPE, GLOBAL_TARGET } from '../domain/scope.js';
import type { ManagedUser } from '../domain/user.js';
import { AxedaError } from '../errors.js';
import { permissionsHeldAnywhere } from '../policy/effective-permissions.js';
import { authorizeUserAction } from '../policy/user-admin.js';
import type { UserAdmin, UserFilter } from '../ports/identity.js';
import type { Page, PageRequest } from '../ports/paging.js';
import { auditDenials, markDenied, writeAudit, type AuditDraft } from './audit.js';
import { loadSnapshot } from './authz-reader.js';
import { parseInput } from './tenant-input.js';
import { actorPermissions, invalidInput, lockUsers, type Services } from './services.js';

export interface UserInput {
  readonly email: string;
  readonly name: string;
}

export interface BanInput {
  readonly reason?: string | null | undefined;
  /** Hasta cuándo; sin fecha, el bloqueo es indefinido. */
  readonly expiresAt?: Date | null | undefined;
}

const createSchema = z.strictObject({
  // Se normaliza ANTES de validar: un correo con espacios o mayúsculas es el mismo correo.
  email: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.email().max(254)),
  name: z.string().trim().min(1).max(200),
});

const banSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).nullish(),
  expiresAt: z.date().nullish(),
});

export interface UserService {
  list(actor: Actor, filter: UserFilter, page: PageRequest): Promise<Page<ManagedUser>>;
  /** Crea la cuenta **sin credencial**: la persona la establece por el flujo normal. */
  create(actor: Actor, input: UserInput): Promise<ManagedUser>;
  ban(actor: Actor, userId: string, input?: BanInput): Promise<ManagedUser>;
  unban(actor: Actor, userId: string): Promise<ManagedUser>;
  /** Devuelve cuántas sesiones se cerraron. */
  revokeSessions(actor: Actor, userId: string): Promise<number>;
}

export function createUserService(services: Services): UserService {
  const { persistence } = services;

  const forbid = (reason: string, permissions: readonly string[] = []): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to manage users.', {
        details: { reason, permissions },
      }),
    );

  const draft = (
    actor: Actor,
    action: AuditAction,
    targetId: string | null,
    metadata: Record<string, unknown> = {},
  ): AuditDraft => ({
    actorId: actor.userId,
    action,
    targetType: 'user',
    targetId,
    scope: GLOBAL_SCOPE,
    meta: actor,
    metadata,
  });

  function admin(): UserAdmin {
    if (services.userAdmin === undefined) {
      throw new AxedaError(
        'AXEDA_FEATURE_DISABLED',
        'User administration is disabled: no user administration is configured.',
      );
    }
    return services.userAdmin;
  }

  /** Permisos globales de quien actúa, leídos de los almacenes (nunca de la caché). */
  async function mustManageUsers(actor: Actor): Promise<void> {
    const held = await actorPermissions(persistence, services, actor, GLOBAL_TARGET);
    if (!held.allows(AXEDA_PERMISSIONS.userManage)) throw forbid('missing_user_permission');
  }

  /**
   * Una acción sobre OTRA persona: permiso global y, además, que su poder administrativo no
   * supere el de quien actúa. Se comprueba antes de revelar si el usuario existe.
   */
  async function authorizeOn(actor: Actor, userId: string): Promise<ManagedUser> {
    const actorHeld = await actorPermissions(persistence, services, actor, GLOBAL_TARGET);
    if (!actorHeld.allows(AXEDA_PERMISSIONS.userManage)) throw forbid('missing_user_permission');
    const user = await admin().get(userId);
    if (user === null) {
      throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${userId}" does not exist.`);
    }
    const snapshot = await loadSnapshot(persistence, userId);
    // Se cuentan también las funciones que exigen 2FA: la protección es para todo su poder.
    const targetHeld = permissionsHeldAnywhere({
      ...snapshot,
      now: services.clock.now(),
      mfaEnabled: true,
    });
    const decision = authorizeUserAction({ actor: actorHeld, target: targetHeld });
    if (!decision.allowed) throw forbid(decision.reason, decision.permissions);
    return user;
  }

  /** Lo que sigue al efecto: invalidar la caché de la persona y dejar constancia, juntos. */
  async function record(actor: Actor, userId: string, entry: AuditDraft): Promise<void> {
    await persistence.transaction(async (stores) => {
      await lockUsers(stores, [actor.userId, userId]);
      await writeAudit(stores, entry, 'success');
    });
  }

  return {
    async list(actor, filter, page) {
      await services.ready();
      const users = admin();
      await mustManageUsers(actor);
      return users.list(filter, page);
    },

    async create(actor, input) {
      await services.ready();
      const users = admin();
      return auditDenials(persistence, draft(actor, 'user.create', null), async () => {
        // Autorizar antes de validar: quien no puede crear usuarios no averigua qué correos existen.
        await mustManageUsers(actor);
        const parsed = parseInput(createSchema, input);
        const created = await users.create(parsed);
        await record(
          actor,
          created.id,
          draft(actor, 'user.create', created.id, { email: created.email }),
        );
        return created;
      });
    },

    async ban(actor, userId, input = {}) {
      await services.ready();
      const users = admin();
      return auditDenials(persistence, draft(actor, 'user.ban', userId), async () => {
        const user = await authorizeOn(actor, userId);
        if (userId === actor.userId) throw invalidInput('You cannot ban yourself.');
        const parsed = parseInput(banSchema, input);
        const expiresAt = parsed.expiresAt ?? null;
        if (expiresAt !== null && expiresAt <= services.clock.now()) {
          throw invalidInput('expiresAt must be in the future.');
        }
        // Primero el bloqueo (impide sesiones nuevas y vacía de poder a las vivas), después se
        // cierran las sesiones abiertas.
        const banned = await users.setBan(userId, { reason: parsed.reason ?? null, expiresAt });
        const closed = await users.revokeSessions(userId);
        await record(
          actor,
          userId,
          draft(actor, 'user.ban', userId, {
            email: user.email,
            reason: parsed.reason ?? null,
            expiresAt: expiresAt?.toISOString() ?? null,
            sessionsClosed: closed,
          }),
        );
        return banned;
      });
    },

    async unban(actor, userId) {
      await services.ready();
      const users = admin();
      return auditDenials(persistence, draft(actor, 'user.unban', userId), async () => {
        const user = await authorizeOn(actor, userId);
        const unbanned = await users.setBan(userId, null);
        await record(actor, userId, draft(actor, 'user.unban', userId, { email: user.email }));
        return unbanned;
      });
    },

    async revokeSessions(actor, userId) {
      await services.ready();
      const users = admin();
      return auditDenials(persistence, draft(actor, 'user.revoke_sessions', userId), async () => {
        const user = await authorizeOn(actor, userId);
        const closed = await users.revokeSessions(userId);
        await record(
          actor,
          userId,
          draft(actor, 'user.revoke_sessions', userId, {
            email: user.email,
            sessionsClosed: closed,
          }),
        );
        return closed;
      });
    },
  };
}
