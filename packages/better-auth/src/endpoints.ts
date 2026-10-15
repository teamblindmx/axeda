import { createAuthEndpoint, getIP, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import {
  AXEDA_PERMISSIONS,
  AxedaError,
  type Actor,
  type AssignmentScope,
  type Axeda,
  type AuditAction,
  type AuditFilter,
} from '@axeda/core';
import { toAssignmentDto, toAuditEventDto, toRoleDto } from './dto.js';
import { toApiError } from './http-errors.js';

/** Lo que cada endpoint exige, para la prueba que recorre todos y para la documentación. */
export interface EndpointAccess {
  readonly requires: string;
  /** Alcance en el que se comprueba el permiso. */
  readonly scope: 'own' | 'any' | 'global' | 'scope-parameter' | 'per-target';
}

const access = (requires: string, scope: EndpointAccess['scope']) => ({
  axeda: { requires, scope } satisfies EndpointAccess,
});

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

const id = z.string().min(1).max(255);
const cursor = z.string().min(1).max(512);
const limit = z.coerce.number().int().min(1).max(MAX_PAGE);

/** Alcances que admite la API en esta versión: los de negocio llegan con las entidades (fase 4). */
const scopeBody = z.union([
  z.strictObject({ type: z.literal('global') }),
  z.strictObject({ type: z.literal('company'), id }),
]);

const scopeQuery = {
  scopeType: z.enum(['global', 'company']).optional(),
  scopeId: id.optional(),
};

function scopeFromQuery(query: {
  scopeType?: 'global' | 'company' | undefined;
  scopeId?: string | undefined;
}): AssignmentScope | undefined {
  if (query.scopeType === undefined) return undefined;
  if (query.scopeType === 'global') return { type: 'global' };
  // Un alcance de compañía sin identificador queda fuera de la lista blanca y el núcleo lo rechaza.
  return { type: 'company', id: query.scopeId ?? '' };
}

const pageOf = (query: { cursor?: string | undefined; limit?: number | undefined }) => ({
  limit: query.limit ?? DEFAULT_PAGE,
  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

interface SessionContext {
  readonly context: { readonly session: { readonly user: { readonly id: string } } };
  readonly headers?: Headers | undefined;
  readonly request?: Request | undefined;
}

/**
 * Quien actúa, a partir de la sesión. `authzVersion` y `twoFactorEnabled` salen de la fila del
 * usuario que Better Auth acaba de leer de la base de datos (nunca del cliente): ahorran
 * consultas y permiten evaluar `requireMfa`.
 */
export function actorFromSession(ctx: SessionContext): Actor {
  const user = ctx.context.session.user as { id: string } & Record<string, unknown>;
  const request = ctx.request;
  const ip = request === undefined ? undefined : (getIP(request, {}) ?? undefined);
  return {
    userId: user.id,
    authzVersion: typeof user['authzVersion'] === 'number' ? user['authzVersion'] : undefined,
    twoFactorEnabled: user['twoFactorEnabled'] === true,
    ip,
    userAgent: ctx.headers?.get('user-agent') ?? request?.headers.get('user-agent') ?? undefined,
  };
}

type CoreProvider = () => Axeda;

/** Ejecuta un caso de uso con el actor de la sesión y traduce sus errores a respuestas HTTP. */
async function run<T>(
  ctx: SessionContext,
  core: CoreProvider,
  work: (axeda: Axeda, actor: Actor) => Promise<T>,
): Promise<T> {
  try {
    return await work(core(), actorFromSession(ctx));
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Los endpoints del plugin. Todos exigen sesión (`sessionMiddleware`) y declaran su permiso en
 * `metadata.axeda`; el permiso lo impone el caso de uso, no el endpoint. Los endpoints de Better
 * Auth solo admiten GET y POST.
 */
export function createEndpoints(core: CoreProvider) {
  return {
    axedaMe: createAuthEndpoint(
      '/axeda/me',
      { method: 'GET', use: [sessionMiddleware], metadata: access('(authenticated)', 'own') },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const [permissions, assignments] = await Promise.all([
            axeda.effectivePermissions(actor),
            axeda.assignments.listForUser(actor, actor.userId),
          ]);
          return ctx.json({
            userId: actor.userId,
            twoFactorEnabled: actor.twoFactorEnabled === true,
            globalPermissions: [...permissions.keys] as string[],
            assignments: assignments.map(toAssignmentDto),
          });
        }),
    ),

    axedaPermissionList: createAuthEndpoint(
      '/axeda/permission/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        metadata: access('axeda:role:manage | axeda:assignment:manage', 'any'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const allowed =
            (await axeda.canAnywhere(actor, AXEDA_PERMISSIONS.roleManage)) ||
            (await axeda.canAnywhere(actor, AXEDA_PERMISSIONS.assignmentManage));
          if (!allowed) {
            throw new AxedaError(
              'AXEDA_FORBIDDEN',
              'You are not allowed to read the permission catalog.',
            );
          }
          return ctx.json({ permissions: [...axeda.catalog] as string[] });
        }),
    ),

    axedaRoleList: createAuthEndpoint(
      '/axeda/role/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({ cursor: cursor.optional(), limit: limit.optional() }),
        metadata: access('axeda:role:manage | axeda:assignment:manage', 'any'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const page = await axeda.roles.list(actor, pageOf(ctx.query));
          return ctx.json({ items: page.items.map(toRoleDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaRoleGet: createAuthEndpoint(
      '/axeda/role/get',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({ id }),
        metadata: access('axeda:role:manage | axeda:assignment:manage', 'any'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toRoleDto(await axeda.roles.get(actor, ctx.query.id))),
        ),
    ),

    axedaRoleCreate: createAuthEndpoint(
      '/axeda/role/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          key: z.string().min(1).max(64),
          name: z.string().min(1).max(200),
          description: z.string().max(1000).nullish(),
          permissions: z.array(z.string().max(200)).max(1000),
          requireMfa: z.boolean().optional(),
        }),
        metadata: access('axeda:role:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toRoleDto(await axeda.roles.create(actor, ctx.body))),
        ),
    ),

    axedaRoleUpdate: createAuthEndpoint(
      '/axeda/role/update',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          id,
          version: z.number().int().min(1),
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(1000).nullish(),
          permissions: z.array(z.string().max(200)).max(1000).optional(),
          requireMfa: z.boolean().optional(),
        }),
        metadata: access('axeda:role:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { id: roleId, version, ...changes } = ctx.body;
          return ctx.json(toRoleDto(await axeda.roles.update(actor, roleId, version, changes)));
        }),
    ),

    axedaRoleSetStatus: createAuthEndpoint(
      '/axeda/role/set-status',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          id,
          version: z.number().int().min(1),
          status: z.enum(['active', 'inactive']),
        }),
        metadata: access('axeda:role:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            toRoleDto(
              await axeda.roles.setStatus(actor, ctx.body.id, ctx.body.version, ctx.body.status),
            ),
          ),
        ),
    ),

    axedaRoleDelete: createAuthEndpoint(
      '/axeda/role/delete',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id }),
        metadata: access('axeda:role:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.roles.delete(actor, ctx.body.id);
          return ctx.json({ deleted: true as const });
        }),
    ),

    axedaAssignmentList: createAuthEndpoint(
      '/axeda/assignment/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          userId: id.optional(),
          ...scopeQuery,
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access('axeda:assignment:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { userId } = ctx.query;
          if (userId !== undefined) {
            const items = await axeda.assignments.listForUser(actor, userId);
            return ctx.json({ items: items.map(toAssignmentDto), nextCursor: null });
          }
          const scope = scopeFromQuery(ctx.query);
          if (scope === undefined) {
            throw new AxedaError('AXEDA_INVALID_INPUT', 'Pass userId, or scopeType (and scopeId).');
          }
          const page = await axeda.assignments.listForScope(actor, scope, pageOf(ctx.query));
          return ctx.json({ items: page.items.map(toAssignmentDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaAssignmentCreate: createAuthEndpoint(
      '/axeda/assignment/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          userId: id,
          roleId: id,
          scope: scopeBody,
          expiresAt: z.iso.datetime().nullish(),
        }),
        metadata: access('axeda:assignment:manage', 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { expiresAt, ...rest } = ctx.body;
          const created = await axeda.assignments.assign(actor, {
            ...rest,
            expiresAt: expiresAt === null || expiresAt === undefined ? null : new Date(expiresAt),
          });
          return ctx.json(toAssignmentDto(created));
        }),
    ),

    axedaAssignmentRevoke: createAuthEndpoint(
      '/axeda/assignment/revoke',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id }),
        metadata: access('axeda:assignment:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.assignments.revoke(actor, ctx.body.id);
          return ctx.json({ revoked: true as const });
        }),
    ),

    axedaAuditList: createAuthEndpoint(
      '/axeda/audit/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          actorId: id.optional(),
          action: z.string().max(64).optional(),
          targetType: z.string().max(64).optional(),
          targetId: id.optional(),
          ...scopeQuery,
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access('axeda:audit:read', 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const {
            action,
            targetType,
            scopeType,
            scopeId,
            cursor: after,
            limit: size,
            ...rest
          } = ctx.query;
          const scope = scopeFromQuery({ scopeType, scopeId });
          const filter = {
            ...rest,
            ...(action === undefined ? {} : { action: action as AuditAction }),
            ...(targetType === undefined
              ? {}
              : { targetType: targetType as AuditFilter['targetType'] }),
            ...(scope === undefined ? {} : { scope }),
          } satisfies AuditFilter;
          const page = await axeda.listAudit(actor, filter, pageOf({ cursor: after, limit: size }));
          return ctx.json({ items: page.items.map(toAuditEventDto), nextCursor: page.nextCursor });
        }),
    ),
  };
}
