import { z } from 'zod';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import { withoutSecret, type Invitation, type StoredInvitation } from '../domain/invitation.js';
import type { Actor, Role, RoleAssignment } from '../domain/role.js';
import { scopeKey, type AssignmentScope, type TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import { authorizeGrant } from '../policy/grant.js';
import type { AxedaStores, DirectoryUser, Page, PageRequest } from '../ports/index.js';
import { auditDenials, markDenied, writeAudit, type AuditDraft } from './audit.js';
import {
  buildToken,
  constantTimeEqual,
  hashSecret,
  newSecret,
  parseToken,
} from './invitation-token.js';
import { parseInput } from './tenant-input.js';
import {
  actorPermissions,
  lockUsers,
  resolveForActor,
  resolveTarget,
  type Services,
} from './services.js';

export interface InvitationInput {
  readonly email: string;
  readonly scope: AssignmentScope;
  readonly roleIds: readonly string[];
  /** Vigencia en horas; por defecto, la configurada. */
  readonly ttlHours?: number | undefined;
}

const MAX_TTL_HOURS = 24 * 30;
const id = z.string().min(1).max(255);

function inputSchema(maxRoles: number) {
  return z.strictObject({
    // Se normaliza ANTES de validar: un correo con espacios o mayúsculas es el mismo correo.
    email: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.email().max(254)),
    scope: z.union([
      z.strictObject({ type: z.literal('global') }),
      z.strictObject({ type: z.enum(['company', 'business']), id }),
    ]),
    roleIds: z.array(id).min(1).max(maxRoles),
    ttlHours: z.number().int().min(1).max(MAX_TTL_HOURS).optional(),
  });
}

export interface InvitationService {
  create(actor: Actor, input: InvitationInput): Promise<Invitation>;
  /** `actor` es quien acepta (la persona invitada, con sesión). Devuelve las asignaciones creadas. */
  accept(actor: Actor, token: string): Promise<readonly RoleAssignment[]>;
  revoke(actor: Actor, invitationId: string): Promise<void>;
  list(
    actor: Actor,
    scope: AssignmentScope,
    options: { readonly pendingOnly?: boolean | undefined },
    page: PageRequest,
  ): Promise<Page<Invitation>>;
}

export function createInvitationService(services: Services): InvitationService {
  const { persistence, options } = services;

  const forbid = (reason: string): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to manage invitations here.', {
        details: { reason },
      }),
    );
  /** Una sola respuesta para todo lo que haga inválida una invitación: no se explica el motivo. */
  const invalid = (reason?: string): AxedaError => {
    const error = new AxedaError(
      'AXEDA_INVITATION_INVALID',
      'The invitation is invalid or has expired.',
      {
        details: reason === undefined ? {} : { reason },
      },
    );
    return reason === undefined ? error : markDenied(error);
  };

  const draft = (
    actor: Actor | null,
    action: 'invitation.create' | 'invitation.accept' | 'invitation.revoke',
    targetId: string | null,
    scope: AssignmentScope | null,
    metadata: Record<string, unknown> = {},
  ): AuditDraft => ({
    actorId: actor?.userId ?? null,
    action,
    targetType: 'invitation',
    targetId,
    scope,
    meta: actor ?? undefined,
    metadata,
  });

  async function mayInvite(stores: AxedaStores, actor: Actor, target: TargetScope): Promise<void> {
    const held = await actorPermissions(stores, services, actor, target);
    if (!held.allows(AXEDA_PERMISSIONS.invitationManage))
      throw forbid('missing_invitation_permission');
  }

  /** La invitación a la que corresponde el token, solo si el secreto es correcto y sigue vigente. */
  async function loadAcceptable(token: string): Promise<StoredInvitation> {
    const parsed = parseToken(token);
    if (parsed === null) throw invalid();
    const stored = await persistence.invitations.get(parsed.id);
    // El secreto se compara siempre, exista o no la invitación, para no dar pistas por el tiempo.
    const matches = constantTimeEqual(
      await hashSecret(parsed.secret),
      stored?.secretHash ?? '0'.repeat(64),
    );
    if (stored === null || !matches) throw invalid();
    const pending = stored.acceptedAt === null && stored.revokedAt === null;
    if (!pending || stored.expiresAt <= services.clock.now()) throw invalid();
    return stored;
  }

  /**
   * Quien acepta debe ser el dueño del correo, con el correo verificado (si no, cualquiera que se
   * registre con ese correo podría aceptarla); y quien invitó debe seguir existiendo y activo.
   */
  async function loadParties(actor: Actor, stored: StoredInvitation) {
    const user = await services.users.find(actor.userId);
    const owner =
      user !== null &&
      !user.banned &&
      user.emailVerified &&
      user.email.toLowerCase() === stored.email;
    const inviter = await services.users.find(stored.invitedBy);
    if (!owner || inviter === null || inviter.banned) throw invalid();
    return { user, inviter };
  }

  /** Se vuelve a comprobar con los permisos ACTUALES de quien invitó: si los perdió, no vale. */
  async function checkRoles(
    stores: AxedaStores,
    stored: StoredInvitation,
    user: DirectoryUser,
    inviter: DirectoryUser,
    target: TargetScope,
  ): Promise<Role[]> {
    const granter = await actorPermissions(
      stores,
      services,
      { userId: inviter.id, twoFactorEnabled: inviter.twoFactorEnabled },
      target,
    );
    const roles: Role[] = [];
    for (const roleId of stored.roleIds) {
      const role = await stores.roles.get(roleId);
      if (role === null) throw invalid('role_missing');
      if (role.requireMfa && !user.twoFactorEnabled) {
        throw new AxedaError(
          'AXEDA_MFA_REQUIRED',
          `Role "${role.key}" requires two-factor authentication, which you have not enabled.`,
        );
      }
      const decision = authorizeGrant({
        granter,
        role,
        scopeType: stored.scope.type,
        via: AXEDA_PERMISSIONS.invitationManage,
      });
      if (!decision.allowed) throw invalid(decision.reason);
      roles.push(role);
    }
    return roles;
  }

  /** Crea las asignaciones que la persona aún no tiene, respetando el límite por usuario. */
  async function createMissing(
    stores: AxedaStores,
    stored: StoredInvitation,
    userId: string,
    roles: readonly Role[],
  ): Promise<RoleAssignment[]> {
    const existing = await stores.assignments.listForUser(userId);
    const has = (roleId: string) =>
      existing.some(
        (item) => item.roleId === roleId && scopeKey(item.scope) === scopeKey(stored.scope),
      );
    const missing = roles.filter((role) => !has(role.id));
    if (existing.length + missing.length > options.limits.maxAssignmentsPerUser) {
      throw new AxedaError(
        'AXEDA_LIMIT_EXCEEDED',
        `A user cannot have more than ${options.limits.maxAssignmentsPerUser} assignments.`,
      );
    }
    const created: RoleAssignment[] = [];
    for (const role of missing) {
      created.push(
        await stores.assignments.create({
          userId,
          roleId: role.id,
          scope: stored.scope,
          grantedBy: stored.invitedBy,
        }),
      );
    }
    return created;
  }

  return {
    async create(actor, input) {
      await services.ready();
      if (services.delivery === undefined) {
        throw new AxedaError(
          'AXEDA_FEATURE_DISABLED',
          'Invitations are disabled: configure how to deliver them (invitations.send).',
        );
      }
      const delivery = services.delivery;
      const parsed = parseInput(inputSchema(options.invitations.maxRoles), input);
      const { email } = parsed;
      const roleIds = [...new Set(parsed.roleIds)];
      const { scope } = parsed;
      const ttlMs = (parsed.ttlHours ?? options.invitations.ttlHours) * 3_600_000;
      const secret = newSecret();
      const secretHash = await hashSecret(secret);
      const base = draft(actor, 'invitation.create', null, scope);

      const outcome = await auditDenials(persistence, base, async () => {
        // Fuera de la transacción: resolver el alcance y comprobar el permiso (ver `assign`).
        const target = await resolveForActor(services, persistence, actor, scope, {
          permission: AXEDA_PERMISSIONS.invitationManage,
          onDenied: () => forbid('missing_invitation_permission'),
        });
        await mayInvite(persistence, actor, target);

        return persistence.transaction(async (stores) => {
          await lockUsers(stores, [actor.userId]);
          await mayInvite(stores, actor, target);
          const granter = await actorPermissions(stores, services, actor, target);
          for (const roleId of roleIds) {
            const role = await stores.roles.get(roleId);
            if (role === null) {
              throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${roleId}" does not exist.`);
            }
            const decision = authorizeGrant({
              granter,
              role,
              scopeType: scope.type,
              via: AXEDA_PERMISSIONS.invitationManage,
            });
            if (!decision.allowed) throw forbid(decision.reason);
          }

          // Una sola pendiente por correo y alcance: reenviar sustituye a la anterior.
          const previous = await stores.invitations.findPending(email, scope);
          if (previous !== null)
            await stores.invitations.close(previous.id, 'revoked', services.clock.now());
          const expiresAt = new Date(services.clock.now().getTime() + ttlMs);
          const created = await stores.invitations.create({
            email,
            scope,
            roleIds,
            invitedBy: actor.userId,
            expiresAt,
            secretHash,
          });
          await writeAudit(
            stores,
            draft(actor, 'invitation.create', created.id, scope, {
              roleIds,
              replaced: previous?.id ?? null,
              expiresAt: expiresAt.toISOString(),
            }),
            'success',
          );
          return created;
        });
      });

      // Después de confirmar: el envío es un efecto externo y no puede ir dentro de la transacción.
      try {
        await delivery.send({
          email,
          token: buildToken(outcome.id, secret),
          expiresAt: outcome.expiresAt,
          scope,
          invitedBy: actor.userId,
        });
      } catch (cause) {
        throw new AxedaError(
          'AXEDA_DELIVERY_FAILED',
          'The invitation was created but could not be delivered. Send it again to replace it.',
          { cause },
        );
      }
      return withoutSecret(outcome);
    },

    async accept(actor, token) {
      await services.ready();
      const stored = await loadAcceptable(token);
      const { user, inviter } = await loadParties(actor, stored);
      const target = await resolveTarget(services, stored.scope).catch(() => {
        throw invalid();
      });

      return auditDenials(
        persistence,
        draft(actor, 'invitation.accept', stored.id, stored.scope),
        () =>
          persistence.transaction(async (stores) => {
            await lockUsers(stores, [inviter.id, user.id]);
            // Primero se cierra: de dos aceptaciones simultáneas solo una lo consigue.
            if (!(await stores.invitations.close(stored.id, 'accepted', services.clock.now()))) {
              throw invalid();
            }
            const roles = await checkRoles(stores, stored, user, inviter, target);
            const created = await createMissing(stores, stored, user.id, roles);
            await writeAudit(
              stores,
              draft(actor, 'invitation.accept', stored.id, stored.scope, {
                invitedBy: stored.invitedBy,
                roleIds: stored.roleIds,
              }),
              'success',
            );
            return created;
          }),
      );
    },

    async revoke(actor, invitationId) {
      await services.ready();
      const hidden = () =>
        markDenied(
          new AxedaError('AXEDA_INVITATION_INVALID', 'The invitation is invalid or has expired.', {
            details: { reason: 'not_visible' },
          }),
        );
      await auditDenials(
        persistence,
        draft(actor, 'invitation.revoke', invitationId, null),
        async () => {
          const stored = await persistence.invitations.get(invitationId);
          if (stored === null) throw hidden();
          const target = await resolveTarget(services, stored.scope, {
            requireUsable: false,
          }).catch(() => {
            throw hidden();
          });
          const held = await actorPermissions(persistence, services, actor, target);
          if (!held.allows(AXEDA_PERMISSIONS.invitationManage)) throw hidden();

          await persistence.transaction(async (stores) => {
            await lockUsers(stores, [actor.userId]);
            const fresh = await actorPermissions(stores, services, actor, target);
            if (!fresh.allows(AXEDA_PERMISSIONS.invitationManage)) throw hidden();
            if (!(await stores.invitations.close(invitationId, 'revoked', services.clock.now()))) {
              throw new AxedaError(
                'AXEDA_INVITATION_INVALID',
                'The invitation is no longer pending.',
              );
            }
            await writeAudit(
              stores,
              draft(actor, 'invitation.revoke', invitationId, stored.scope, {
                email: stored.email,
              }),
              'success',
            );
          });
        },
      );
    },

    async list(actor, scope, listOptions, page) {
      await services.ready();
      const denied = () =>
        new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to list invitations here.');
      const target = await resolveForActor(services, persistence, actor, scope, {
        permission: AXEDA_PERMISSIONS.invitationManage,
        onDenied: denied,
        requireUsable: false,
      });
      const held = await actorPermissions(persistence, services, actor, target);
      if (!held.allows(AXEDA_PERMISSIONS.invitationManage)) throw denied();
      return persistence.invitations.list(
        scope,
        { pendingOnly: listOptions.pendingOnly === true, now: services.clock.now() },
        page,
      );
    },
  };
}
