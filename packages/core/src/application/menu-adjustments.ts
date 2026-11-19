import { z } from 'zod';
import { labelsOf, menuLabelSchema, menuOrderSchema } from '../config/menus.js';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { Actor } from '../domain/role.js';
import { GLOBAL_TARGET, type TargetScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { StoredMenuAdjustment } from '../ports/menu-adjustments.js';
import type { AxedaStores } from '../ports/persistence.js';
import { auditDenials, markDenied, writeAudit, type AuditDraft } from './audit.js';
import { actorPermissions, lockUsers, resolveForActor, type Services } from './services.js';
import { parseInput } from './tenant-input.js';

/** Dónde se ajusta el menú: el de todos, o el de una compañía (sus negocios y sedes lo heredan). */
export type MenuLevel =
  { readonly type: 'global' } | { readonly type: 'company'; readonly id: string };

export interface MenuAdjustmentInput {
  readonly level: MenuLevel;
  /** La clave del elemento declarado en el código. */
  readonly itemKey: string;
  readonly hidden?: boolean | undefined;
  readonly order?: number | undefined;
  /** Un texto, o uno por idioma: `{ es: 'Caja', en: 'Till' }`. */
  readonly label?: string | Readonly<Record<string, string>> | undefined;
}

export interface MenuAdjustmentService {
  list(actor: Actor, level: MenuLevel): Promise<readonly StoredMenuAdjustment[]>;
  /** Crea o sustituye el ajuste del elemento en ese nivel. */
  set(actor: Actor, input: MenuAdjustmentInput): Promise<StoredMenuAdjustment>;
  /** Vuelve a lo que dice el código (o al ajuste global, si es una compañía). */
  reset(actor: Actor, level: MenuLevel, itemKey: string): Promise<void>;
}

const levelSchema = z.union([
  z.strictObject({ type: z.literal('global') }),
  z.strictObject({ type: z.literal('company'), id: z.string().min(1).max(255) }),
]);

export function createMenuAdjustmentService(services: Services): MenuAdjustmentService {
  const { persistence, options } = services;
  const itemSchema = z
    .string()
    .refine((key) => options.menus.items.has(key), 'is not an item of the menu declared in code');
  const setSchema = z
    .strictObject({
      level: levelSchema,
      itemKey: itemSchema,
      hidden: z.boolean().optional(),
      order: menuOrderSchema.optional(),
      label: menuLabelSchema.optional(),
    })
    .refine(
      (value) =>
        value.hidden !== undefined || value.order !== undefined || value.label !== undefined,
      'give at least one of hidden, order or label',
    );

  const denied = () =>
    markDenied(
      new AxedaError('AXEDA_FORBIDDEN', 'You are not allowed to adjust this menu.', {
        details: { reason: 'missing_menu_permission' },
      }),
    );

  /** Dónde se comprueba el permiso: en global, o en la compañía (que debe verse). */
  async function targetOf(actor: Actor, level: unknown): Promise<TargetScope> {
    const parsed = levelSchema.safeParse(level);
    if (!parsed.success)
      throw new AxedaError('AXEDA_INVALID_INPUT', 'level must be global or a company.');
    if (parsed.data.type === 'global') return GLOBAL_TARGET;
    return resolveForActor(services, persistence, actor, parsed.data, {
      permission: AXEDA_PERMISSIONS.menuManage,
      onDenied: denied,
      requireUsable: false,
    });
  }

  async function mustManage(stores: AxedaStores, actor: Actor, target: TargetScope) {
    const held = await actorPermissions(stores, services, actor, target);
    if (!held.allows(AXEDA_PERMISSIONS.menuManage)) throw denied();
  }

  const companyOf = (level: MenuLevel): string | null =>
    level.type === 'global' ? null : level.id;

  const draft = (
    actor: Actor,
    action: 'menu.adjust' | 'menu.reset',
    level: unknown,
    itemKey: unknown,
  ): AuditDraft => {
    const parsed = levelSchema.safeParse(level);
    return {
      actorId: actor.userId,
      action,
      targetType: 'menu',
      targetId: typeof itemKey === 'string' ? itemKey.slice(0, 64) : null,
      scope: parsed.success && parsed.data.type === 'company' ? parsed.data : { type: 'global' },
      meta: actor,
    };
  };

  return {
    async list(actor, level) {
      await services.ready();
      const target = await targetOf(actor, level);
      await mustManage(persistence, actor, target);
      return persistence.menuAdjustments.list(companyOf(level));
    },

    async set(actor, input) {
      await services.ready();
      const base = draft(actor, 'menu.adjust', input?.level, input?.itemKey);
      return auditDenials(persistence, base, async () => {
        // Autorizar antes de validar el resto: quien no puede no averigua qué elementos hay.
        const target = await targetOf(actor, input?.level);
        await mustManage(persistence, actor, target);
        const parsed = parseInput(setSchema, input);
        return persistence.transaction(async (stores) => {
          await mustManage(stores, actor, target);
          await lockUsers(stores, [actor.userId]);
          const saved = await stores.menuAdjustments.set({
            companyId: companyOf(parsed.level),
            itemKey: parsed.itemKey,
            hidden: parsed.hidden ?? null,
            order: parsed.order ?? null,
            labels: parsed.label === undefined ? null : labelsOf(parsed.label),
            updatedBy: actor.userId,
          });
          await writeAudit(
            stores,
            {
              ...base,
              metadata: {
                hidden: saved.hidden,
                order: saved.order,
                labels: saved.labels,
              },
            },
            'success',
          );
          return saved;
        });
      });
    },

    async reset(actor, level, itemKey) {
      await services.ready();
      const base = draft(actor, 'menu.reset', level, itemKey);
      await auditDenials(persistence, base, async () => {
        const target = await targetOf(actor, level);
        await mustManage(persistence, actor, target);
        if (typeof itemKey !== 'string' || itemKey.length > 64) {
          throw new AxedaError('AXEDA_INVALID_INPUT', 'itemKey must be a menu item key.');
        }
        await persistence.transaction(async (stores) => {
          await mustManage(stores, actor, target);
          await stores.menuAdjustments.delete(companyOf(level), itemKey);
          await writeAudit(stores, base, 'success');
        });
      });
    },
  };
}
