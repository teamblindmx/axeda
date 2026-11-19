import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import type { MenuLevel, StoredMenuAdjustment } from '@teamblind/axeda-core';
import { access, id, run, type CoreProvider } from './endpoints.js';

export interface MenuAdjustmentDto {
  /** `null` en un ajuste global. */
  companyId: string | null;
  itemKey: string;
  hidden: boolean | null;
  order: number | null;
  labels: Record<string, string> | null;
  updatedBy: string;
  updatedAt: string;
}

const toDto = (item: StoredMenuAdjustment): MenuAdjustmentDto => ({
  companyId: item.companyId,
  itemKey: item.itemKey,
  hidden: item.hidden,
  order: item.order,
  labels: item.labels === null ? null : { ...item.labels },
  updatedBy: item.updatedBy,
  updatedAt: item.updatedAt.toISOString(),
});

const level = z.union([
  z.strictObject({ type: z.literal('global') }),
  z.strictObject({ type: z.literal('company'), id }),
]);
const itemKey = z.string().min(1).max(64);
const MANAGE = 'axeda:menu:manage';

/** Ajustes del menú del código: ocultar, ordenar o renombrar, globales o de una compañía. */
export function createMenuAdjustmentEndpoints(core: CoreProvider) {
  return {
    axedaMenuAdjustmentList: createAuthEndpoint(
      '/axeda/menu-adjustment/list',
      {
        method: 'GET',
        use: [sessionMiddleware],
        query: z.strictObject({
          scopeType: z.enum(['global', 'company']),
          scopeId: id.optional(),
        }),
        metadata: access(MANAGE, 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          const where: MenuLevel =
            ctx.query.scopeType === 'global'
              ? { type: 'global' }
              : { type: 'company', id: ctx.query.scopeId ?? '' };
          const items = await axeda.menuAdjustments.list(actor, where);
          return ctx.json({ items: items.map(toDto) });
        }),
    ),

    axedaMenuAdjustmentSet: createAuthEndpoint(
      '/axeda/menu-adjustment/set',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          level,
          itemKey,
          hidden: z.boolean().optional(),
          order: z.number().int().optional(),
          label: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
        }),
        metadata: access(MANAGE, 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toDto(await axeda.menuAdjustments.set(actor, ctx.body))),
        ),
    ),

    axedaMenuAdjustmentReset: createAuthEndpoint(
      '/axeda/menu-adjustment/reset',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ level, itemKey }),
        metadata: access(MANAGE, 'scope-parameter'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) => {
          await axeda.menuAdjustments.reset(actor, ctx.body.level, ctx.body.itemKey);
          return ctx.json({ reset: true as const });
        }),
    ),
  };
}
