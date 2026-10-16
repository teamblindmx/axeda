import { z } from 'zod';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { Actor, Role, RoleAssignment } from '../domain/role.js';
import { scopeContains, type AssignmentScope, type TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import { scopesGranting } from '../policy/effective-permissions.js';
import { authorizeGrant } from '../policy/grant.js';
import { authorizeRevoke } from '../policy/revoke.js';
import type { AxedaStores, Page, PageRequest } from '../ports/persistence.js';
import { auditDenials, markDenied, writeAudit, type AuditDraft } from './audit.js';
import { loadSnapshot } from './authz-reader.js';
import {
  actorPermissions,
  invalidInput,
  lockUsers,
  resolveTarget,
  type Services,
} from './services.js';

export interface AssignInput {
  readonly userId: string;
  readonly roleId: string;
  readonly scope: AssignmentScope;
  readonly expiresAt?: Date | null | undefined;
}

const id = z.string().min(1).max(255);
const assignSchema = z.strictObject({
  userId: id,
  roleId: id,
  scope: z.union([
    z.strictObject({ type: z.literal('global') }),
    z.strictObject({ type: z.enum(['company', 'business']), id }),
  ]),
  expiresAt: z.date().nullish(),
});

export interface AssignmentService {
  /** Asignaciones de un usuario que `actor` puede ver (las propias, o las de alcances que administra). */
  listForUser(actor: Actor, userId: string): Promise<readonly RoleAssignment[]>;
  listForScope(
    actor: Actor,
    scope: AssignmentScope,
    page: PageRequest,
  ): Promise<Page<RoleAssignment>>;
  assign(actor: Actor, input: AssignInput): Promise<RoleAssignment>;
  revoke(actor: Actor, assignmentId: string): Promise<void>;
}

export function createAssignmentService(services: Services): AssignmentService {
  const { persistence, options } = services;

  const forbid = (reason: string, permissions: readonly unknown[] = []): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to manage this assignment.', {
        details: { reason, permissions },
      }),
    );

  const draft = (
    actor: Actor,
    action: AuditDraft['action'],
    targetId: string | null,
    scope: AssignmentScope | null,
  ) =>
    ({
      actorId: actor.userId,
      action,
      targetType: 'assignment',
      targetId,
      scope,
      meta: actor,
    }) satisfies AuditDraft;

  async function requireRole(stores: AxedaStores, roleId: string): Promise<Role> {
    const role = await stores.roles.get(roleId);
    if (role === null)
      throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${roleId}" does not exist.`);
    return role;
  }

  async function requireUser(userId: string) {
    const user = await services.users.find(userId);
    if (user === null)
      throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${userId}" does not exist.`);
    return user;
  }

  /**
   * Resuelve el alcance. Si no se puede (negocio inexistente o sin resolvedor), solo quien
   * administra a nivel global ve el motivo; para los demás es una denegación, sin revelar nada.
   */
  async function resolveForActor(
    stores: AxedaStores,
    actor: Actor,
    scope: AssignmentScope,
    onDenied: () => Error = () => forbid('missing_assignment_permission'),
  ): Promise<TargetScope> {
    try {
      return await resolveTarget(services, scope);
    } catch (error) {
      const global = await actorPermissions(stores, services, actor, { type: 'global' });
      if (global.allows(AXEDA_PERMISSIONS.assignmentManage)) throw error;
      throw onDenied();
    }
  }

  async function assertCanManage(
    stores: AxedaStores,
    actor: Actor,
    target: TargetScope,
  ): Promise<void> {
    const held = await actorPermissions(stores, services, actor, target);
    if (!held.allows(AXEDA_PERMISSIONS.assignmentManage)) {
      throw forbid('missing_assignment_permission');
    }
  }

  async function canManage(actor: Actor, scope: AssignmentScope): Promise<boolean> {
    const target = await resolveTarget(services, scope);
    const held = await actorPermissions(persistence, services, actor, target);
    return held.allows(AXEDA_PERMISSIONS.assignmentManage);
  }

  async function assertCanAssign(
    stores: AxedaStores,
    actor: Actor,
    role: Role,
    scope: AssignmentScope,
    target: TargetScope,
  ): Promise<void> {
    const granter = await actorPermissions(stores, services, actor, target);
    const decision = authorizeGrant({ granter, role, scopeType: scope.type });
    if (!decision.allowed) throw forbid(decision.reason, decision.permissions);
  }

  return {
    async listForUser(actor, userId) {
      await services.ready();
      const all = await persistence.assignments.listForUser(userId);
      if (userId === actor.userId) return all;

      const snapshot = await loadSnapshot(persistence, actor.userId);
      const managed = scopesGranting(
        { ...snapshot, now: services.clock.now(), mfaEnabled: actor.twoFactorEnabled },
        AXEDA_PERMISSIONS.assignmentManage,
      );
      // Una asignación de negocio solo se ve por un alcance de compañía si se conoce la compañía.
      return all.filter((assignment) =>
        managed.some((container) => scopeContains(container, assignment.scope)),
      );
    },

    async listForScope(actor, scope, page) {
      await services.ready();
      if (!(await canManage(actor, scope))) {
        throw new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to list this scope.');
      }
      return persistence.assignments.listForScope(scope, page);
    },

    async assign(actor, input) {
      await services.ready();
      const parsed = assignSchema.safeParse(input);
      if (!parsed.success) {
        throw invalidInput(parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      const { userId, roleId, scope } = parsed.data;
      const expiresAt = parsed.data.expiresAt ?? null;
      if (expiresAt !== null && expiresAt <= services.clock.now()) {
        throw invalidInput('expiresAt must be in the future.');
      }

      const base = draft(actor, 'assignment.create', null, scope);

      return auditDenials(persistence, base, async () => {
        // ANTES de la transacción: comprobar el permiso y consultar al usuario y al alcance. Dentro
        // de una transacción no se puede usar nada que no sean sus almacenes: en una base de una
        // sola conexión (SQLite) la transacción la tiene tomada y la consulta esperaría por siempre.
        // Va primero el permiso, antes de revelar si el usuario, la función o el negocio existen.
        const target = await resolveForActor(persistence, actor, scope);
        await assertCanManage(persistence, actor, target);
        const user = await requireUser(userId);

        return persistence.transaction(async (stores) => {
          // Bloqueo + invalidación de caché de quien concede y de quien recibe (ver `lockUsers`).
          await lockUsers(stores, [actor.userId, userId]);
          const role = await requireRole(stores, roleId);
          if (role.requireMfa && !user.twoFactorEnabled) {
            throw new AxedaError(
              'AXEDA_MFA_REQUIRED',
              `Role "${role.key}" requires two-factor authentication, which the user has not enabled.`,
            );
          }
          await assertCanAssign(stores, actor, role, scope, target);

          if (
            (await stores.assignments.countForUser(userId)) >= options.limits.maxAssignmentsPerUser
          ) {
            throw new AxedaError(
              'AXEDA_LIMIT_EXCEEDED',
              `A user cannot have more than ${options.limits.maxAssignmentsPerUser} assignments.`,
            );
          }
          const created = await stores.assignments.create({
            userId,
            roleId,
            scope,
            grantedBy: actor.userId,
            expiresAt,
          });
          await writeAudit(
            stores,
            {
              ...draft(actor, 'assignment.create', created.id, scope),
              metadata: {
                userId,
                roleId,
                roleKey: role.key,
                expiresAt: expiresAt?.toISOString() ?? null,
              },
            },
            'success',
          );
          return created;
        });
      });
    },

    async revoke(actor, assignmentId) {
      await services.ready();
      const base = draft(actor, 'assignment.revoke', assignmentId, null);
      const notFound = () =>
        new AxedaError(
          'AXEDA_ASSIGNMENT_NOT_FOUND',
          `Assignment "${assignmentId}" does not exist.`,
        );
      // Sin permiso sobre el alcance, la asignación "no existe" para quien pregunta (404).
      const hidden = () =>
        markDenied(
          new AxedaError('AXEDA_ASSIGNMENT_NOT_FOUND', notFound().message, {
            details: { reason: 'missing_assignment_permission' },
          }),
        );

      await auditDenials(persistence, base, async () => {
        // Antes de la transacción (ver `assign`): leer la asignación y resolver su alcance.
        const first = await persistence.assignments.get(assignmentId);
        if (first === null) throw notFound();
        const target = await resolveForActor(persistence, actor, first.scope, hidden);

        await persistence.transaction(async (stores) => {
          await lockUsers(stores, [actor.userId, first.userId]);
          // Se vuelve a leer: mientras se esperaba el bloqueo pudo revocarse.
          const assignment = await stores.assignments.get(assignmentId);
          if (assignment === null) throw notFound();
          const role = await requireRole(stores, assignment.roleId);

          const granter = await actorPermissions(stores, services, actor, target);
          const decision = authorizeRevoke({ granter, role });
          if (!decision.allowed) {
            throw decision.reason === 'missing_assignment_permission'
              ? hidden()
              : forbid(decision.reason, decision.permissions);
          }

          await stores.assignments.revoke(assignmentId);
          await writeAudit(
            stores,
            {
              ...draft(actor, 'assignment.revoke', assignmentId, assignment.scope),
              metadata: { userId: assignment.userId, roleId: role.id, roleKey: role.key },
            },
            'success',
          );
        });
      });
    },
  };
}
