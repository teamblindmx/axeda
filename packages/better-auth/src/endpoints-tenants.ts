import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import { toBusinessDto, toCompanyDto, toInvitationDto, toAssignmentDto } from './dto.js';
import {
  access,
  cursor,
  id,
  limit,
  pageOf,
  run,
  scopeBody,
  scopeFromQuery,
  scopeQuery,
  type CoreProvider,
} from './endpoints.js';
import { toApiError } from './http-errors.js';
import { AxedaError } from '@axeda/core';

const deleted = z.enum(['exclude', 'include', 'only']);
const version = z.number().int().min(1);
const status = z.enum(['active', 'inactive']);
const url = z.string().max(2048);
const slug = z.string().min(1).max(63);
const name = z.string().min(1).max(200);
const metadata = z.record(z.string().max(100), z.unknown());

/** Compañías y negocios. El permiso lo impone el caso de uso (ver `AxedaError` → 403 / 404). */
export function createTenantEndpoints(core: CoreProvider) {
  return {
    axedaCompanyList: createAuthEndpoint(
      '/axeda/company/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          deleted: deleted.optional(),
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access('(membership)', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const page = await axeda.companies.list(
            actor,
            { deleted: ctx.query.deleted },
            pageOf(ctx.query),
          );
          return ctx.json({ items: page.items.map(toCompanyDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaCompanyGet: createAuthEndpoint(
      '/axeda/company/get',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({ id }),
        metadata: access('(membership)', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toCompanyDto(await axeda.companies.get(actor, ctx.query.id))),
        ),
    ),

    axedaCompanyCreate: createAuthEndpoint(
      '/axeda/company/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          slug,
          name,
          legalName: name.nullish(),
          logoUrl: url.nullish(),
          faviconUrl: url.nullish(),
          metadata: metadata.optional(),
        }),
        metadata: access('axeda:company:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toCompanyDto(await axeda.companies.create(actor, ctx.body))),
        ),
    ),

    axedaCompanyUpdate: createAuthEndpoint(
      '/axeda/company/update',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          id,
          version,
          name: name.optional(),
          legalName: name.nullish(),
          logoUrl: url.nullish(),
          faviconUrl: url.nullish(),
          metadata: metadata.optional(),
        }),
        metadata: access('axeda:company:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { id: companyId, version: expected, ...changes } = ctx.body;
          return ctx.json(
            toCompanyDto(await axeda.companies.update(actor, companyId, expected, changes)),
          );
        }),
    ),

    axedaCompanySetStatus: createAuthEndpoint(
      '/axeda/company/set-status',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id, version, status }),
        metadata: access('axeda:company:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            toCompanyDto(
              await axeda.companies.setStatus(
                actor,
                ctx.body.id,
                ctx.body.version,
                ctx.body.status,
              ),
            ),
          ),
        ),
    ),

    axedaCompanyDelete: createAuthEndpoint(
      '/axeda/company/delete',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id, version, immediate: z.boolean().optional() }),
        metadata: access('axeda:company:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.companies.delete(actor, ctx.body.id, ctx.body.version, {
            immediate: ctx.body.immediate,
          });
          return ctx.json({ deleted: true as const });
        }),
    ),

    axedaCompanyRestore: createAuthEndpoint(
      '/axeda/company/restore',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id, version }),
        metadata: access('axeda:company:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            toCompanyDto(await axeda.companies.restore(actor, ctx.body.id, ctx.body.version)),
          ),
        ),
    ),

    axedaBusinessList: createAuthEndpoint(
      '/axeda/business/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          companyId: id,
          deleted: deleted.optional(),
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access('(membership)', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const page = await axeda.businesses.list(
            actor,
            ctx.query.companyId,
            { deleted: ctx.query.deleted },
            pageOf(ctx.query),
          );
          return ctx.json({ items: page.items.map(toBusinessDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaBusinessGet: createAuthEndpoint(
      '/axeda/business/get',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({ id }),
        metadata: access('(membership)', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toBusinessDto(await axeda.businesses.get(actor, ctx.query.id))),
        ),
    ),

    axedaBusinessCreate: createAuthEndpoint(
      '/axeda/business/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          companyId: id,
          slug,
          name,
          logoUrl: url.nullish(),
          faviconUrl: url.nullish(),
          metadata: metadata.optional(),
        }),
        metadata: access('axeda:business:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { companyId, ...input } = ctx.body;
          return ctx.json(toBusinessDto(await axeda.businesses.create(actor, companyId, input)));
        }),
    ),

    axedaBusinessUpdate: createAuthEndpoint(
      '/axeda/business/update',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          id,
          version,
          name: name.optional(),
          logoUrl: url.nullish(),
          faviconUrl: url.nullish(),
          metadata: metadata.optional(),
        }),
        metadata: access('axeda:business:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const { id: businessId, version: expected, ...changes } = ctx.body;
          return ctx.json(
            toBusinessDto(await axeda.businesses.update(actor, businessId, expected, changes)),
          );
        }),
    ),

    axedaBusinessSetStatus: createAuthEndpoint(
      '/axeda/business/set-status',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id, version, status }),
        metadata: access('axeda:business:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            toBusinessDto(
              await axeda.businesses.setStatus(
                actor,
                ctx.body.id,
                ctx.body.version,
                ctx.body.status,
              ),
            ),
          ),
        ),
    ),

    axedaBusinessDelete: createAuthEndpoint(
      '/axeda/business/delete',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id, version, immediate: z.boolean().optional() }),
        metadata: access('axeda:business:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.businesses.delete(actor, ctx.body.id, ctx.body.version, {
            immediate: ctx.body.immediate,
          });
          return ctx.json({ deleted: true as const });
        }),
    ),

    axedaBusinessRestore: createAuthEndpoint(
      '/axeda/business/restore',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id, version }),
        metadata: access('axeda:business:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            toBusinessDto(await axeda.businesses.restore(actor, ctx.body.id, ctx.body.version)),
          ),
        ),
    ),
  };
}

/** Invitaciones. Aceptar solo exige sesión: lo que lo autoriza es el secreto y el correo verificado. */
export function createInvitationEndpoints(core: CoreProvider) {
  return {
    axedaInvitationList: createAuthEndpoint(
      '/axeda/invitation/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          ...scopeQuery,
          pendingOnly: z.enum(['true', 'false']).optional(),
          cursor: cursor.optional(),
          limit: limit.optional(),
        }),
        metadata: access('axeda:invitation:manage', 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const scope = scopeFromQuery(ctx.query);
          if (scope === undefined) {
            throw new AxedaError('AXEDA_INVALID_INPUT', 'Pass scopeType (and scopeId).');
          }
          const page = await axeda.invitations.list(
            actor,
            scope,
            { pendingOnly: ctx.query.pendingOnly === 'true' },
            pageOf(ctx.query),
          );
          return ctx.json({ items: page.items.map(toInvitationDto), nextCursor: page.nextCursor });
        }),
    ),

    axedaInvitationCreate: createAuthEndpoint(
      '/axeda/invitation/create',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          email: z.string().min(3).max(254),
          scope: scopeBody,
          roleIds: z.array(id).min(1).max(50),
          ttlHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 30)
            .optional(),
        }),
        metadata: access('axeda:invitation:manage', 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toInvitationDto(await axeda.invitations.create(actor, ctx.body))),
        ),
    ),

    axedaInvitationAccept: createAuthEndpoint(
      '/axeda/invitation/accept',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ token: z.string().min(1).max(512) }),
        metadata: access('(authenticated; the secret and the verified email authorize)', 'own'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const created = await axeda.invitations.accept(actor, ctx.body.token);
          return ctx.json({ assignments: created.map(toAssignmentDto) });
        }),
    ),

    axedaInvitationRevoke: createAuthEndpoint(
      '/axeda/invitation/revoke',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ id }),
        metadata: access('axeda:invitation:manage', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.invitations.revoke(actor, ctx.body.id);
          return ctx.json({ revoked: true as const });
        }),
    ),
  };
}

/**
 * Identidad pública: nombre y logos de una compañía o negocio activo. **No** pide sesión, por eso
 * está aparte y solo se registra si la aplicación lo activa (`publicIdentity: true`). Una
 * compañía inexistente, inactiva o borrada responde igual: 404.
 */
export function createPublicEndpoints(core: CoreProvider, enabled: () => boolean) {
  return {
    axedaPublicIdentity: createAuthEndpoint(
      '/axeda/public/identity',
      {
        method: 'GET',
        query: z.strictObject({ company: slug, business: slug.optional() }),
        metadata: { axeda: { public: true, requires: '(public)', scope: 'own' as const } },
      },
      async (ctx) => {
        try {
          const identity = enabled() ? await core().publicIdentity(ctx.query) : null;
          if (identity === null) {
            throw new AxedaError('AXEDA_COMPANY_NOT_FOUND', 'Not found.');
          }
          return ctx.json(identity);
        } catch (error) {
          throw toApiError(error);
        }
      },
    ),
  };
}
