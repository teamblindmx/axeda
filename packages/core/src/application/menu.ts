import { DEFAULT_LABEL, type ResolvedMenu, type ResolvedMenuItem } from '../config/menus.js';
import type { PermissionSet } from '../policy/effective-permissions.js';

/** Un elemento del menú ya filtrado para una persona y un alcance. */
export interface MenuNode {
  readonly key: string;
  readonly label: string;
  readonly icon: string | null;
  /** `null` en un grupo. */
  readonly path: string | null;
  /** Para cada acción declarada, si la persona la tiene en este alcance. */
  readonly can: Readonly<Record<string, boolean>>;
  readonly children: readonly MenuNode[];
}

/**
 * El texto en el idioma pedido: el exacto, luego el idioma base (`es-MX` → `es`), luego inglés,
 * luego el texto sin idioma y, por último, el primero que haya. Nunca queda vacío.
 */
export function pickLabel(
  labels: Readonly<Record<string, string>>,
  locale: string | undefined,
): string {
  const wanted = (locale ?? '').toLowerCase();
  const candidates = [wanted, wanted.split('-')[0] ?? '', 'en', DEFAULT_LABEL];
  const names = Object.keys(labels);
  for (const candidate of candidates) {
    const name = names.find((n) => n.toLowerCase() === candidate);
    if (name !== undefined) return labels[name] ?? '';
  }
  return labels[names.sort()[0] ?? ''] ?? '';
}

function build(
  menu: ResolvedMenu,
  item: ResolvedMenuItem,
  held: PermissionSet,
  locale: string | undefined,
): MenuNode | null {
  const children = item.children.flatMap((key) => {
    const child = menu.items.get(key);
    const node = child === undefined ? null : build(menu, child, held, locale);
    return node === null ? [] : [node];
  });

  if (item.children.length > 0) {
    // Un grupo se muestra si algún hijo es visible.
    if (children.length === 0) return null;
  } else if (item.requires === null || !held.allows(item.requires)) {
    // Una hoja sin su permiso no sale nunca (y la validación exige que toda hoja lo declare).
    return null;
  }
  return {
    key: item.key,
    label: pickLabel(item.labels, locale),
    icon: item.icon,
    path: item.path,
    can: Object.fromEntries(item.actions.map((action) => [action, held.allows(action)])),
    children,
  };
}

/** El menú visible con los permisos `held` (los efectivos de la persona en el alcance pedido). */
export function buildMenu(
  menu: ResolvedMenu,
  held: PermissionSet,
  locale: string | undefined,
): MenuNode[] {
  return menu.roots.flatMap((key) => {
    const item = menu.items.get(key);
    const node = item === undefined ? null : build(menu, item, held, locale);
    return node === null ? [] : [node];
  });
}
