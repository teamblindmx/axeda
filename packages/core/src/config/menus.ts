import { z } from 'zod';
import { isWildcard, parsePermissionKey, type PermissionKey } from '../domain/permission-key.js';
import { AxedaError } from '../errors.js';

/** Un elemento del menú declarado en el código. */
export interface MenuDefinition {
  readonly key: string;
  /** Clave del elemento padre; sin ella es de primer nivel. */
  readonly parent?: string | undefined;
  /** Texto, o un texto por idioma: `{ es: 'Facturas', en: 'Invoices' }`. */
  readonly label: string | Readonly<Record<string, string>>;
  readonly icon?: string | undefined;
  readonly order?: number | undefined;
  /** Ruta de la aplicación (solo en las hojas). Siempre empieza por `/`. */
  readonly path?: string | undefined;
  /** Permiso que hace visible la hoja. Obligatorio en las hojas. */
  readonly requires?: string | undefined;
  /** Permisos de las acciones de la pantalla (botones); se informa si se tienen o no. */
  readonly actions?: readonly string[] | undefined;
}

export interface ResolvedMenuItem {
  readonly key: string;
  readonly parent: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly icon: string | null;
  readonly order: number;
  readonly path: string | null;
  readonly requires: PermissionKey | null;
  readonly actions: readonly PermissionKey[];
  /** Claves de los hijos, ya ordenadas. */
  readonly children: readonly string[];
}

export interface ResolvedMenu {
  readonly items: ReadonlyMap<string, ResolvedMenuItem>;
  /** Claves de primer nivel, ya ordenadas. */
  readonly roots: readonly string[];
}

export const EMPTY_MENU: ResolvedMenu = { items: new Map(), roots: [] };

/** Profundidad máxima (un grupo dentro de un grupo dentro de un grupo, y las hojas). */
export const MAX_MENU_DEPTH = 3;
const MAX_ITEMS = 200;
/** Etiqueta con la que se guarda un texto sin idioma. */
export const DEFAULT_LABEL = '*';

const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;
const ICON = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const text = z.string().trim().min(1).max(100);
const itemSchema = z.strictObject({
  key: z.string().regex(KEY),
  parent: z.string().regex(KEY).optional(),
  label: z.union([
    text,
    z.record(z.string().regex(LOCALE), text).refine((l) => Object.keys(l).length > 0),
  ]),
  icon: z.string().regex(ICON).optional(),
  order: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  // Solo rutas de la propia aplicación: nada de `javascript:`, `//otro-sitio` ni espacios.
  path: z
    .string()
    .max(512)
    .regex(/^\/(?!\/)\S*$/)
    .optional(),
  requires: z.string().optional(),
  actions: z.array(z.string()).max(20).optional(),
});

const invalid = (message: string): never => {
  throw new AxedaError('AXEDA_INVALID_CONFIG', `Invalid Axeda menus: ${message}`);
};

function concretePermission(
  raw: string,
  catalog: ReadonlySet<PermissionKey>,
  where: string,
): PermissionKey {
  const key = parsePermissionKey(raw);
  if (isWildcard(key)) invalid(`${where} "${raw}" cannot be a wildcard.`);
  if (!catalog.has(key)) invalid(`${where} "${raw}" is not in the permission catalog.`);
  return key;
}

type Parsed = z.infer<typeof itemSchema>;

function parseItems(raw: unknown): Parsed[] {
  if (!Array.isArray(raw)) return invalid('menus must be an array.');
  if (raw.length > MAX_ITEMS) invalid(`at most ${MAX_ITEMS} items.`);
  return raw.map((entry, index) => {
    const result = itemSchema.safeParse(entry);
    if (result.success) return result.data;
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(item)'}: ${i.message}`);
    return invalid(`item ${index}: ${detail.join('; ')}`);
  });
}

const labelsOf = (label: Parsed['label']): Record<string, string> =>
  typeof label === 'string' ? { [DEFAULT_LABEL]: label } : { ...label };

/** Estructura: claves únicas, padres que existen, sin ciclos y sin pasar de la profundidad máxima. */
function checkTree(items: readonly Parsed[]): Map<string, Parsed> {
  const byKey = new Map<string, Parsed>();
  for (const item of items) {
    if (byKey.has(item.key)) invalid(`key "${item.key}" is declared twice.`);
    byKey.set(item.key, item);
  }
  for (const item of items) {
    if (item.parent !== undefined && !byKey.has(item.parent)) {
      invalid(`"${item.key}" has parent "${item.parent}", which does not exist.`);
    }
    let depth = 1;
    for (let cursor = item; cursor.parent !== undefined; depth += 1) {
      const next = byKey.get(cursor.parent);
      if (next === undefined || depth > MAX_MENU_DEPTH) break;
      cursor = next;
    }
    if (depth > MAX_MENU_DEPTH) {
      invalid(`"${item.key}" is nested deeper than ${MAX_MENU_DEPTH} levels (or in a cycle).`);
    }
  }
  return byKey;
}

/** Una hoja lleva ruta y permiso; un grupo solo agrupa. Así un menú nunca sale sin su permiso. */
function checkShape(item: Parsed, isGroup: boolean): void {
  if (isGroup) {
    if (item.path !== undefined || item.requires !== undefined || item.actions !== undefined) {
      invalid(`"${item.key}" has children, so it cannot have a path, "requires" or "actions".`);
    }
    return;
  }
  if (item.path === undefined) invalid(`"${item.key}" has no children, so it needs a path.`);
  if (item.requires === undefined) {
    invalid(
      `"${item.key}" needs "requires": a menu entry without a permission would show to everyone.`,
    );
  }
}

const byOrder = (items: ReadonlyMap<string, ResolvedMenuItem>) => (a: string, b: string) => {
  const left = items.get(a);
  const right = items.get(b);
  return (left?.order ?? 0) - (right?.order ?? 0) || a.localeCompare(b);
};

/** Claves de los hijos de cada elemento. */
function childrenByParent(items: readonly Parsed[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parent !== undefined) {
      children.set(item.parent, [...(children.get(item.parent) ?? []), item.key]);
    }
  }
  return children;
}

function toResolved(
  item: Parsed,
  children: readonly string[],
  catalog: ReadonlySet<PermissionKey>,
): ResolvedMenuItem {
  checkShape(item, children.length > 0);
  return {
    key: item.key,
    parent: item.parent ?? null,
    labels: labelsOf(item.label),
    icon: item.icon ?? null,
    order: item.order ?? 0,
    path: item.path ?? null,
    requires:
      item.requires === undefined
        ? null
        : concretePermission(item.requires, catalog, `"${item.key}" requires`),
    actions: [...new Set(item.actions ?? [])].map((action) =>
      concretePermission(action, catalog, `"${item.key}" action`),
    ),
    children,
  };
}

/** Valida los menús declarados y devuelve el árbol resuelto. Lanza `AXEDA_INVALID_CONFIG`. */
export function resolveMenus(raw: unknown, catalog: ReadonlySet<PermissionKey>): ResolvedMenu {
  if (raw === undefined) return EMPTY_MENU;
  const parsed = parseItems(raw);
  checkTree(parsed);
  const childrenOf = childrenByParent(parsed);

  const items = new Map<string, ResolvedMenuItem>();
  for (const item of parsed) {
    items.set(item.key, toResolved(item, childrenOf.get(item.key) ?? [], catalog));
  }
  const sort = byOrder(items);
  const sorted = new Map<string, ResolvedMenuItem>();
  for (const [key, item] of items) {
    sorted.set(key, { ...item, children: [...item.children].sort(sort) });
  }
  const roots = parsed
    .filter((item) => item.parent === undefined)
    .map((item) => item.key)
    .sort(sort);
  return { items: sorted, roots };
}
