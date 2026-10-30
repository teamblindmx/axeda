import { z } from 'zod';
import { resolveRoleDefinition, ROLE_KEY } from '../config/options.js';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import { covers, type PermissionKey } from '../domain/permission-key.js';
import type { Actor, Role, RoleStatus } from '../domain/role.js';
import { GLOBAL_SCOPE, GLOBAL_TARGET } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import { authorizeRoleChange } from '../policy/role-change.js';
import type { AxedaStores, Page, PageRequest } from '../ports/persistence.js';
import { markDenied, runAudited, writeAudit, type AuditDraft } from './audit.js';
import { loadSnapshot } from './authz-reader.js';
import {
  SUPER_ADMIN_ROLE_KEY,
  actorPermissions,
  actorPolicyData,
  asInput,
  invalidInput,
  type Services,
} from './services.js';
import { permissionsHeldAnywhere } from '../policy/effective-permissions.js';

export interface RoleInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly permissions: readonly string[];
  readonly requireMfa?: boolean | undefined;
}

export interface RoleUpdate {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly requireMfa?: boolean | undefined;
}

const roleInputSchema = z.strictObject({
  key: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullish(),
  permissions: z.array(z.string()),
  requireMfa: z.boolean().optional(),
});

const roleUpdateSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullish(),
  permissions: z.array(z.string()).optional(),
  requireMfa: z.boolean().optional(),
});

function parseShape<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw invalidInput(
    result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  );
}

/** Los permisos de `next` que `previous` no concedía ya (por igualdad o por comodín). */
const addedPermissions = (
  previous: readonly PermissionKey[],
  next: readonly PermissionKey[],
): PermissionKey[] => next.filter((candidate) => !previous.some((held) => covers(held, candidate)));

export interface RoleService {
  list(actor: Actor, page: PageRequest): Promise<Page<Role>>;
  get(actor: Actor, id: string): Promise<Role>;
  create(actor: Actor, input: RoleInput): Promise<Role>;
  update(actor: Actor, id: string, expectedVersion: number, changes: RoleUpdate): Promise<Role>;
  setStatus(actor: Actor, id: string, expectedVersion: number, status: RoleStatus): Promise<Role>;
  delete(actor: Actor, id: string): Promise<void>;
}

export function createRoleService(services: Services): RoleService {
  const { persistence, options } = services;

  const forbid = (reason: string, permissions: readonly PermissionKey[] = []): AxedaError =>
    markDenied(
      new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to change roles.', {
        details: { reason, permissions },
      }),
    );

  const draft = (actor: Actor, action: AuditDraft['action'], targetId: string | null) =>
    ({
      actorId: actor.userId,
      action,
      targetType: 'role',
      targetId,
      scope: GLOBAL_SCOPE,
      meta: actor,
    }) satisfies AuditDraft;

  /** Quien lista o consulta funciones debe poder gestionarlas o asignarlas en algún alcance. */
  async function assertCanRead(actor: Actor): Promise<void> {
    await services.ready();
    const snapshot = await loadSnapshot(persistence, actor.userId);
    const held = permissionsHeldAnywhere(actorPolicyData(services, actor, snapshot));
    if (
      !held.allows(AXEDA_PERMISSIONS.roleManage) &&
      !held.allows(AXEDA_PERMISSIONS.assignmentManage)
    ) {
      throw new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to read roles.');
    }
  }

  async function loadMutable(stores: AxedaStores, id: string): Promise<Role> {
    const role = await stores.roles.get(id);
    if (role === null) throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${id}" does not exist.`);
    if (role.managed) {
      throw new AxedaError(
        'AXEDA_ROLE_MANAGED',
        `Role "${role.key}" is declared in code and cannot be changed through the API.`,
      );
    }
    return role;
  }

  async function authorize(
    stores: AxedaStores,
    actor: Actor,
    added: readonly PermissionKey[],
  ): Promise<void> {
    const held = await actorPermissions(stores, services, actor, GLOBAL_TARGET);
    const decision = authorizeRoleChange({ actor: held, added });
    if (!decision.allowed) throw forbid(decision.reason, decision.permissions);
  }

  return {
    async list(actor, page) {
      await assertCanRead(actor);
      return persistence.roles.list(page);
    },

    async get(actor, id) {
      await assertCanRead(actor);
      const role = await persistence.roles.get(id);
      if (role === null) {
        throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${id}" does not exist.`);
      }
      return role;
    },

    async create(actor, input) {
      await services.ready();
      const parsed = parseShape(roleInputSchema, input);

      return runAudited(
        persistence,
        { ...draft(actor, 'role.create', null), metadata: { key: parsed.key } },
        async (stores) => {
          // Primero la versión de política (sirve de bloqueo entre ediciones de funciones) y el
          // permiso: quien no puede gestionar funciones no averigua nada del catálogo ni de las claves.
          await stores.authz.bumpPolicyVersion();
          await authorize(stores, actor, []);
          if (parsed.key === SUPER_ADMIN_ROLE_KEY || !ROLE_KEY.test(parsed.key)) {
            throw invalidInput(`role key "${parsed.key}" is reserved or invalid.`);
          }
          const definition = asInput(() =>
            resolveRoleDefinition(
              parsed.key,
              {
                name: parsed.name,
                ...(parsed.description ? { description: parsed.description } : {}),
                permissions: parsed.permissions,
                ...(parsed.requireMfa === undefined ? {} : { requireMfa: parsed.requireMfa }),
              },
              [...services.catalog],
              options.limits.maxPermissionsPerRole,
            ),
          );
          await authorize(stores, actor, definition.permissions);
          const role = await stores.roles.create({
            key: definition.key,
            name: definition.name,
            description: definition.description,
            permissions: definition.permissions,
            requireMfa: definition.requireMfa,
          });
          await writeAudit(
            stores,
            {
              ...draft(actor, 'role.create', role.id),
              metadata: { key: role.key, permissions: role.permissions },
            },
            'success',
          );
          return role;
        },
      );
    },

    async update(actor, id, expectedVersion, changes) {
      await services.ready();
      const parsed = parseShape(roleUpdateSchema, changes);

      return runAudited(persistence, draft(actor, 'role.update', id), async (stores) => {
        await stores.authz.bumpPolicyVersion();
        await authorize(stores, actor, []);
        const role = await loadMutable(stores, id);
        const permissions =
          parsed.permissions === undefined
            ? undefined
            : asInput(
                () =>
                  resolveRoleDefinition(
                    role.key,
                    { permissions: parsed.permissions ?? [] },
                    [...services.catalog],
                    options.limits.maxPermissionsPerRole,
                  ).permissions,
              );
        const added =
          permissions === undefined ? [] : addedPermissions(role.permissions, permissions);
        // Quitar el 2FA devuelve todos los permisos de la función a quienes la tienen sin 2FA:
        // igual que reactivarla, equivale a concederlos, así que se exige cubrirlos.
        const dropsMfa = role.requireMfa && parsed.requireMfa === false;
        await authorize(stores, actor, dropsMfa ? (permissions ?? role.permissions) : added);

        const updated = await stores.roles.update(id, expectedVersion, {
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          ...(permissions === undefined ? {} : { permissions }),
          ...(parsed.requireMfa === undefined ? {} : { requireMfa: parsed.requireMfa }),
        });
        await writeAudit(
          stores,
          {
            ...draft(actor, 'role.update', id),
            metadata: { key: role.key, added, fields: Object.keys(parsed) },
          },
          'success',
        );
        return updated;
      });
    },

    async setStatus(actor, id, expectedVersion, status) {
      await services.ready();
      if (status !== 'active' && status !== 'inactive') {
        throw invalidInput('status must be "active" or "inactive".');
      }
      return runAudited(persistence, draft(actor, 'role.set_status', id), async (stores) => {
        await stores.authz.bumpPolicyVersion();
        await authorize(stores, actor, []);
        const role = await loadMutable(stores, id);
        // Reactivar una función devuelve todos sus permisos a quienes la tienen asignada:
        // equivale a concederlos, así que se exige cubrirlos.
        await authorize(stores, actor, status === 'active' ? role.permissions : []);
        const updated = await stores.roles.update(id, expectedVersion, { status });
        await writeAudit(
          stores,
          { ...draft(actor, 'role.set_status', id), metadata: { key: role.key, status } },
          'success',
        );
        return updated;
      });
    },

    async delete(actor, id) {
      await services.ready();
      await runAudited(persistence, draft(actor, 'role.delete', id), async (stores) => {
        await stores.authz.bumpPolicyVersion();
        await authorize(stores, actor, []);
        const role = await loadMutable(stores, id);
        await stores.roles.delete(id);
        await writeAudit(
          stores,
          { ...draft(actor, 'role.delete', id), metadata: { key: role.key } },
          'success',
        );
      });
    },
  };
}
