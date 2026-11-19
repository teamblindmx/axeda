import { APIError, createAuthEndpoint, getIP, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { Actor, Axeda, StaffMember } from '@teamblind/axeda-core';
import { toApiError } from './http-errors.js';
import { access, cursor, id, limit, pageOf, run, type CoreProvider } from './endpoints.js';

/** Una cuenta de personal en la API. Nunca lleva el hash del PIN. */
export interface StaffMemberDto {
  userId: string;
  companyId: string;
  businessId: string | null;
  siteId: string | null;
  username: string;
  name: string;
  banned: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  lockCount: number;
  createdBy: string;
  createdAt: string;
  pinChangedAt: string;
}

export const toStaffMemberDto = (member: StaffMember): StaffMemberDto => ({
  userId: member.userId,
  companyId: member.companyId,
  businessId: member.businessId,
  siteId: member.siteId,
  username: member.username,
  name: member.name,
  banned: member.banned,
  failedAttempts: member.failedAttempts,
  lockedUntil: member.lockedUntil?.toISOString() ?? null,
  lockCount: member.lockCount,
  createdBy: member.createdBy,
  createdAt: member.createdAt.toISOString(),
  pinChangedAt: member.pinChangedAt.toISOString(),
});

const MANAGE = 'axeda:staff:manage';
const pin = z.string().min(1).max(16);
const target = z.strictObject({ userId: id });
const placeQuery = {
  scopeType: z.enum(['company', 'business', 'site']),
  scopeId: id,
};

/**
 * Personal con usuario y PIN. Todo exige sesión salvo `staff/sign-in`, que abre una: es la entrada de
 * la terminal del negocio.
 */
export function createStaffEndpoints(core: CoreProvider) {
  const manage = <T extends object>(
    path: string,
    work: (userId: string, axeda: Axeda, actor: Actor) => Promise<T>,
  ) =>
    createAuthEndpoint(
      path,
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: target,
        metadata: access(MANAGE, 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => ctx.json(await work(ctx.body.userId, axeda, actor))),
    );

  return {
    axedaStaffSignIn: createAuthEndpoint(
      '/axeda/staff/sign-in',
      {
        method: 'POST',
        body: z.strictObject({
          company: z.string().min(1).max(64),
          username: z.string().min(1).max(64),
          pin,
        }),
        metadata: {
          axeda: { public: true, requires: '(public; the PIN authorizes)', scope: 'own' as const },
        },
      },
      async (ctx) => {
        let userId: string;
        try {
          const request = ctx.request;
          ({ userId } = await core().staff.signIn(ctx.body, {
            ip:
              request === undefined
                ? undefined
                : (getIP(request, ctx.context.options) ?? undefined),
            userAgent: ctx.headers?.get('user-agent') ?? undefined,
          }));
        } catch (error) {
          throw toApiError(error);
        }
        const user = await ctx.context.internalAdapter.findUserById(userId);
        // Abre la sesión como cualquier otro inicio de Better Auth (sus ganchos y la vida máxima
        // de Axeda incluidos) y deja la cookie.
        const session =
          user === null ? null : await ctx.context.internalAdapter.createSession(userId);
        if (user === null || session === null) {
          throw new APIError('INTERNAL_SERVER_ERROR', {
            code: 'AXEDA_INTERNAL_ERROR',
            message: 'The session could not be created.',
          });
        }
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ userId, name: user.name });
      },
    ),

    axedaStaffList: createAuthEndpoint(
      '/axeda/staff/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          ...placeQuery,
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access(MANAGE, 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const page = await axeda.staff.list(
            actor,
            { type: ctx.query.scopeType, id: ctx.query.scopeId },
            pageOf(ctx.query),
          );
          return ctx.json({ items: page.items.map(toStaffMemberDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaStaffGet: createAuthEndpoint(
      '/axeda/staff/get',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: target,
        metadata: access(MANAGE, 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toStaffMemberDto(await axeda.staff.get(actor, ctx.query.userId))),
        ),
    ),

    axedaStaffCreate: createAuthEndpoint(
      '/axeda/staff/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          scope: z.strictObject({ type: z.enum(['company', 'business', 'site']), id }),
          username: z.string().min(1).max(64),
          name: z.string().min(1).max(200),
          roleIds: z.array(id).max(50).optional(),
        }),
        metadata: access(MANAGE, 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { member, pin: created } = await axeda.staff.create(actor, ctx.body);
          // El PIN sale una sola vez, en esta respuesta (que no se guarda en caché: no-store).
          return ctx.json({ member: toStaffMemberDto(member), pin: created });
        }),
    ),

    axedaStaffRename: createAuthEndpoint(
      '/axeda/staff/rename',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ userId: id, username: z.string().min(1).max(64) }),
        metadata: access(MANAGE, 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            toStaffMemberDto(await axeda.staff.rename(actor, ctx.body.userId, ctx.body.username)),
          ),
        ),
    ),

    axedaStaffResetPin: manage('/axeda/staff/reset-pin', (userId, axeda, actor) =>
      axeda.staff.resetPin(actor, userId),
    ),
    axedaStaffUnlock: manage('/axeda/staff/unlock', async (userId, axeda, actor) =>
      toStaffMemberDto(await axeda.staff.unlock(actor, userId)),
    ),
    axedaStaffSuspend: manage('/axeda/staff/suspend', async (userId, axeda, actor) =>
      toStaffMemberDto(await axeda.staff.suspend(actor, userId)),
    ),
    axedaStaffReactivate: manage('/axeda/staff/reactivate', async (userId, axeda, actor) =>
      toStaffMemberDto(await axeda.staff.reactivate(actor, userId)),
    ),
    axedaStaffRemove: manage('/axeda/staff/remove', async (userId, axeda, actor) => {
      await axeda.staff.remove(actor, userId);
      return { removed: true as const };
    }),

    axedaStaffChangePin: createAuthEndpoint(
      '/axeda/staff/change-pin',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ currentPin: pin, newPin: pin }),
        metadata: access('(authenticated; your own PIN, giving the current one)', 'own'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.staff.changePin(actor, ctx.body);
          return ctx.json({ changed: true as const });
        }),
    ),
  };
}
