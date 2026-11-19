import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import { access, id, run, type CoreProvider } from './endpoints.js';

const feature = z.string().min(1).max(64);

/** Funcionalidades por compañía: verlas quien ve la compañía, cambiarlas solo la plataforma. */
export function createFeatureEndpoints(core: CoreProvider) {
  return {
    axedaFeatureList: createAuthEndpoint(
      '/axeda/feature/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({ companyId: id }),
        metadata: access('(authenticated; whoever sees the company)', 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json({ items: [...(await axeda.features.list(actor, ctx.query.companyId))] }),
        ),
    ),

    axedaFeatureSet: createAuthEndpoint(
      '/axeda/feature/set',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ companyId: id, feature, enabled: z.boolean() }),
        metadata: access('axeda:feature:manage', 'global'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(
            await axeda.features.set(actor, ctx.body.companyId, ctx.body.feature, ctx.body.enabled),
          ),
        ),
    ),
  };
}
