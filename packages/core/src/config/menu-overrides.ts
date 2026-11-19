import type { ResolvedMenu, ResolvedMenuItem } from './menus.js';

/**
 * Un ajuste a un elemento del menú declarado en el código. Solo se puede ocultar, mover o
 * renombrar: nunca añadir una opción ni cambiar su ruta o su permiso.
 */
export interface MenuAdjustment {
  readonly itemKey: string;
  /** `true` oculta el elemento y todo lo que tenga debajo. */
  readonly hidden: boolean | null;
  /** Posición entre sus hermanos (como `order` en el código). */
  readonly order: number | null;
  /** Textos por idioma (`*` es el texto sin idioma); sustituyen a los del código. */
  readonly labels: Readonly<Record<string, string>> | null;
}

const byOrder = (items: ReadonlyMap<string, ResolvedMenuItem>) => (a: string, b: string) =>
  (items.get(a)?.order ?? 0) - (items.get(b)?.order ?? 0) || a.localeCompare(b);

function adjusted(
  item: ResolvedMenuItem,
  adjustment: MenuAdjustment | undefined,
): ResolvedMenuItem {
  if (adjustment === undefined) return item;
  return {
    ...item,
    order: adjustment.order ?? item.order,
    labels: adjustment.labels ?? item.labels,
  };
}

/** El valor de la capa de arriba si lo tiene; si no, el de abajo. */
const layered = <T>(next: T | null, previous: T | null | undefined): T | null =>
  next ?? previous ?? null;

/** Las capas en una: la de cada compañía manda sobre la global, campo a campo. */
function merge(layers: readonly (readonly MenuAdjustment[])[]): Map<string, MenuAdjustment> {
  const merged = new Map<string, MenuAdjustment>();
  for (const adjustment of layers.flat()) {
    const previous = merged.get(adjustment.itemKey);
    merged.set(adjustment.itemKey, {
      itemKey: adjustment.itemKey,
      hidden: layered(adjustment.hidden, previous?.hidden),
      order: layered(adjustment.order, previous?.order),
      labels: layered(adjustment.labels, previous?.labels),
    });
  }
  return merged;
}

/**
 * El menú con los ajustes aplicados, por capas: primero los globales y después los de la compañía,
 * que mandan sobre los anteriores campo a campo. Un ajuste de un elemento que ya no está en el
 * código se ignora. Función pura.
 */
export function applyMenuAdjustments(
  menu: ResolvedMenu,
  layers: readonly (readonly MenuAdjustment[])[],
): ResolvedMenu {
  const merged = merge(layers);
  if (merged.size === 0) return menu;

  const hidden = new Set(
    [...merged.values()].filter((a) => a.hidden === true).map((a) => a.itemKey),
  );
  const items = new Map<string, ResolvedMenuItem>();
  for (const [key, item] of menu.items) {
    if (!hidden.has(key)) items.set(key, adjusted(item, merged.get(key)));
  }
  const sort = byOrder(items);
  // Al ocultar un elemento desaparece de su padre; lo que tenía debajo ya no se alcanza.
  const visible = (key: string) => items.has(key);
  const result = new Map<string, ResolvedMenuItem>();
  for (const [key, item] of items) {
    result.set(key, { ...item, children: item.children.filter(visible).sort(sort) });
  }
  return { items: result, roots: menu.roots.filter(visible).sort(sort) };
}
