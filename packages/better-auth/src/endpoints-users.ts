import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import { toManagedUserDto } from './dto.js';
import {
  access,
  cursor,
  id,
  limit,
  pageOf,
  run,
  scopeFromQuery,
  scopeQuery,
  type CoreProvider,
} from './endpoints.js';

const LOCALE = /^[A-Za-z]{2}(-[A-Za-z0-9]{2,8})?$/;

/** El primer idioma de `Accept-Language` (`es-MX,es;q=0.9,en;q=0.8` → `es-MX`), si es válido. */
export function localeFromHeader(header: string | null | undefined): string | undefined {
  const first = header?.split(',')[0]?.split(';')[0]?.trim();
  return first !== undefined && LOCALE.test(first) ? first : undefined;
}

/**
 * Administración de usuarios (solo global, `axeda:user:manage`) y el menú de cada persona.
 * Axeda no maneja contraseñas: `user/create` crea la cuenta sin credencial.
 */
export function createUserEndpoints(core: CoreProvider) {
  return {
    axedaUserList: createAuthEndpoint(
      '/axeda/user/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          emailPrefix: z.string().min(1).max(254).optional(),
          banned: z.enum(['true', 'false']).optional(),
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access('axeda:user:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { emailPrefix, banned } = ctx.query;
          const page = await axeda.users.list(
            actor,
            { emailPrefix, banned: banned === undefined ? undefined : banned === 'true' },
            pageOf(ctx.query),
          );
          return ctx.json({ items: page.items.map(toManagedUserDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaUserCreate: createAuthEndpoint(
      '/axeda/user/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          email: z.string().min(3).max(254),
          name: z.string().min(1).max(200),
        }),
        metadata: access('axeda:user:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toManagedUserDto(await axeda.users.create(actor, ctx.body))),
        ),
    ),

    axedaUserBan: createAuthEndpoint(
      '/axeda/user/ban',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          id,
          reason: z.string().min(1).max(500).nullish(),
          expiresAt: z.iso.datetime().nullish(),
        }),
        metadata: access('axeda:user:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { expiresAt, reason } = ctx.body;
          const banned = await axeda.users.ban(actor, ctx.body.id, {
            reason,
            expiresAt: expiresAt === null || expiresAt === undefined ? null : new Date(expiresAt),
          });
          return ctx.json(toManagedUserDto(banned));
        }),
    ),

    axedaUserUnban: createAuthEndpoint(
      '/axeda/user/unban',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id }),
        metadata: access('axeda:user:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toManagedUserDto(await axeda.users.unban(actor, ctx.body.id))),
        ),
    ),

    axedaUserRevokeSessions: createAuthEndpoint(
      '/axeda/user/revoke-sessions',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id }),
        metadata: access('axeda:user:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json({ revoked: await axeda.users.revokeSessions(actor, ctx.body.id) }),
        ),
    ),

    axedaMenu: createAuthEndpoint(
      '/axeda/menu',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          ...scopeQuery,
          locale: z.string().regex(LOCALE).optional(),
        }),
        metadata: access('(authenticated; the menu only lists what you may use)', 'own'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const locale =
            ctx.query.locale ??
            localeFromHeader(
              ctx.headers?.get('accept-language') ?? ctx.request?.headers.get('accept-language'),
            );
          const menu = await axeda.menu(actor, { scope: scopeFromQuery(ctx.query), locale });
          return ctx.json({ items: menu });
        }),
    ),
  };
}
