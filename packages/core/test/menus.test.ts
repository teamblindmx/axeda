import { describe, expect, it } from 'vitest';
import {
  MAX_MENU_DEPTH,
  isAxedaError,
  pickLabel,
  resolveOptions,
  type AxedaOptions,
  type MenuDefinition,
  type MenuNode,
} from '../src/index.js';
import { createFixture } from './fixture.js';

const PERMISSIONS = [
  'invoice:read',
  'invoice:create',
  'invoice:delete',
  'report:read',
  'user:read',
];

const MENUS: MenuDefinition[] = [
  { key: 'billing', label: { es: 'Facturación', en: 'Billing' }, icon: 'receipt', order: 10 },
  {
    key: 'invoices',
    parent: 'billing',
    path: '/facturas',
    label: { es: 'Facturas', en: 'Invoices' },
    requires: 'invoice:read',
    actions: ['invoice:create', 'invoice:delete'],
    order: 1,
  },
  {
    key: 'reports',
    parent: 'billing',
    path: '/reportes',
    label: 'Reports',
    requires: 'report:read',
    order: 2,
  },
  { key: 'people', path: '/personas', label: { en: 'People' }, requires: 'user:read', order: 20 },
];

const options = (menus: unknown): AxedaOptions =>
  ({ permissions: PERMISSIONS, menus }) as AxedaOptions;

function invalid(menus: unknown, fragment: string) {
  try {
    resolveOptions(options(menus));
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(isAxedaError(error, 'AXEDA_INVALID_CONFIG')).toBe(true);
    expect((error as Error).message).toContain(fragment);
  }
}

describe('menu validation at startup', () => {
  it('accepts a valid menu and orders it', () => {
    const { menus } = resolveOptions(options(MENUS));
    expect(menus.roots).toEqual(['billing', 'people']);
    expect(menus.items.get('billing')?.children).toEqual(['invoices', 'reports']);
    expect(menus.items.get('invoices')?.requires).toBe('invoice:read');
  });

  it('works with no menu at all', () => {
    expect(resolveOptions({ permissions: PERMISSIONS }).menus.roots).toEqual([]);
  });

  it.each([
    [
      'a leaf without "requires" (it would show to everyone)',
      [{ key: 'a', path: '/a', label: 'A' }],
      'needs "requires"',
    ],
    ['a leaf without a path', [{ key: 'a', label: 'A', requires: 'invoice:read' }], 'needs a path'],
    [
      'a group with a path',
      [
        { key: 'g', path: '/g', label: 'G' },
        { key: 'c', parent: 'g', path: '/c', label: 'C', requires: 'invoice:read' },
      ],
      'cannot have a path',
    ],
    [
      'a group that declares its own permission',
      [
        { key: 'g', label: 'G', requires: 'invoice:read' },
        { key: 'c', parent: 'g', path: '/c', label: 'C', requires: 'invoice:read' },
      ],
      'cannot have a path',
    ],
    [
      'a permission that is not in the catalog (typo)',
      [{ key: 'a', path: '/a', label: 'A', requires: 'invoice:raed' }],
      'not in the permission catalog',
    ],
    [
      'a wildcard permission',
      [{ key: 'a', path: '/a', label: 'A', requires: 'invoice:*' }],
      'wildcard',
    ],
    [
      'an action not in the catalog',
      [{ key: 'a', path: '/a', label: 'A', requires: 'invoice:read', actions: ['invoice:nope'] }],
      'action',
    ],
    ['a duplicated key', [{ ...MENUS[3] }, { ...MENUS[3] }], 'declared twice'],
    [
      'a parent that does not exist',
      [{ key: 'a', parent: 'ghost', path: '/a', label: 'A', requires: 'invoice:read' }],
      'does not exist',
    ],
    [
      'a cycle',
      [
        { key: 'a', parent: 'b', label: 'A' },
        { key: 'b', parent: 'a', label: 'B' },
      ],
      'cycle',
    ],
    [
      'an unsafe path (javascript:)',
      [{ key: 'a', path: 'javascript:alert(1)', label: 'A', requires: 'invoice:read' }],
      'path',
    ],
    [
      'a path to another site (//)',
      [{ key: 'a', path: '//evil.example/x', label: 'A', requires: 'invoice:read' }],
      'path',
    ],
    [
      'a path with spaces',
      [{ key: 'a', path: '/a b', label: 'A', requires: 'invoice:read' }],
      'path',
    ],
    [
      'an invalid key',
      [{ key: 'Bad Key', path: '/a', label: 'A', requires: 'invoice:read' }],
      'key',
    ],
    [
      'an invalid locale',
      [{ key: 'a', path: '/a', label: { 'not a locale': 'A' }, requires: 'invoice:read' }],
      'label',
    ],
    ['an empty label', [{ key: 'a', path: '/a', label: '', requires: 'invoice:read' }], 'label'],
    [
      'an unknown field',
      [{ key: 'a', path: '/a', label: 'A', requires: 'invoice:read', roles: ['x'] }],
      'roles',
    ],
    ['menus that are not an array', { key: 'a' }, 'array'],
  ])('rejects %s', (_label, menus, fragment) => {
    invalid(menus, fragment);
  });

  it('rejects nesting deeper than the maximum', () => {
    const chain: MenuDefinition[] = [{ key: 'l0', label: 'L0' }];
    for (let level = 1; level <= MAX_MENU_DEPTH; level += 1) {
      chain.push({
        key: `l${level}`,
        parent: `l${level - 1}`,
        label: `L${level}`,
        ...(level === MAX_MENU_DEPTH ? { path: '/x', requires: 'invoice:read' } : {}),
      });
    }
    invalid(chain, 'deeper');
    // y justo en el límite sí vale
    const ok = chain.slice(0, MAX_MENU_DEPTH);
    const last = ok[ok.length - 1] as MenuDefinition;
    ok[ok.length - 1] = { ...last, path: '/x', requires: 'invoice:read' };
    expect(() => resolveOptions(options(ok))).not.toThrow();
  });

  it('rejects too many items', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      key: `k${index}`,
      path: '/x',
      label: 'X',
      requires: 'invoice:read',
    }));
    invalid(many, 'at most');
  });
});

describe('labels', () => {
  it('picks the requested language, then the base language, then English, then anything', () => {
    const labels = { es: 'Facturas', en: 'Invoices', fr: 'Factures' };
    expect(pickLabel(labels, 'es')).toBe('Facturas');
    expect(pickLabel(labels, 'ES')).toBe('Facturas');
    expect(pickLabel(labels, 'es-MX')).toBe('Facturas');
    expect(pickLabel(labels, 'de')).toBe('Invoices');
    expect(pickLabel(labels, undefined)).toBe('Invoices');
    expect(pickLabel({ fr: 'Factures', de: 'Rechnungen' }, 'es')).toBe('Rechnungen');
    expect(pickLabel({ '*': 'Plain' }, 'es')).toBe('Plain');
  });
});

describe('the menu a person gets', () => {
  const names = (nodes: readonly MenuNode[]): string[] =>
    nodes.flatMap((node) => [
      node.key,
      ...names(node.children).map((child) => `${node.key}>${child}`),
    ]);

  async function world() {
    const f = await createFixture({ permissions: PERMISSIONS, menus: MENUS } as AxedaOptions);
    await f.company('A');
    await f.role('reader', ['invoice:read']);
    await f.role('biller', ['invoice:*']);
    await f.role('analyst', ['report:read', 'user:read']);
    return f;
  }

  it('shows nothing to someone with no permissions', async () => {
    const f = await world();
    expect(await f.axeda.menu(f.user('nobody'))).toEqual([]);
  });

  it('shows only the entries whose permission the person has, and a parent only if a child shows', async () => {
    const f = await world();
    f.user('alice');
    await f.give('alice', 'reader');
    const menu = await f.axeda.menu({ userId: 'alice' });
    expect(names(menu)).toEqual(['billing', 'billing>invoices']);
    expect(menu[0]?.children[0]).toMatchObject({
      label: 'Invoices',
      path: '/facturas',
      icon: null,
    });

    f.user('bob');
    await f.give('bob', 'analyst');
    expect(names(await f.axeda.menu({ userId: 'bob' }))).toEqual([
      'billing',
      'billing>reports',
      'people',
    ]);
  });

  it('reports, per action, whether the person has it', async () => {
    const f = await world();
    f.user('alice');
    f.user('carol');
    await f.give('alice', 'reader');
    await f.give('carol', 'biller');
    const invoices = (nodes: MenuNode[]) => nodes[0]?.children[0];
    expect(invoices(await f.axeda.menu({ userId: 'alice' }))?.can).toEqual({
      'invoice:create': false,
      'invoice:delete': false,
    });
    expect(invoices(await f.axeda.menu({ userId: 'carol' }))?.can).toEqual({
      'invoice:create': true,
      'invoice:delete': true,
    });
  });

  it('speaks the requested language', async () => {
    const f = await world();
    await f.give('admin', 'reader').catch(() => undefined);
    const es = await f.axeda.menu(f.admin, { locale: 'es' });
    expect(es[0]).toMatchObject({ key: 'billing', label: 'Facturación' });
    expect(es[0]?.children.map((c) => c.label)).toEqual(['Facturas', 'Reports']);
  });

  it('evaluates the permissions in the requested scope, not everywhere', async () => {
    const f = await world();
    f.user('alice');
    await f.give('alice', 'reader', { type: 'company', id: 'A' });
    expect(await f.axeda.menu({ userId: 'alice' })).toEqual([]);
    expect(
      names(await f.axeda.menu({ userId: 'alice' }, { scope: { type: 'company', id: 'A' } })),
    ).toEqual(['billing', 'billing>invoices']);
  });

  it('gives an empty menu for a scope that does not exist, without saying so', async () => {
    const f = await world();
    expect(await f.axeda.menu(f.admin, { scope: { type: 'company', id: 'ghost' } })).toEqual([]);
    expect(await f.axeda.menu(f.admin, { scope: { type: 'business', id: 'ghost' } })).toEqual([]);
  });

  it('empties the menu of an inactive company and brings it back on restore', async () => {
    const f = await world();
    f.user('alice');
    await f.give('alice', 'reader', { type: 'company', id: 'A' });
    const scope = { type: 'company', id: 'A' } as const;
    expect((await f.axeda.menu({ userId: 'alice' }, { scope })).length).toBe(1);
    await f.axeda.companies.setStatus(f.admin, 'A', 1, 'inactive');
    expect(await f.axeda.menu({ userId: 'alice' }, { scope })).toEqual([]);
    await f.axeda.companies.setStatus(f.admin, 'A', 2, 'active');
    expect((await f.axeda.menu({ userId: 'alice' }, { scope })).length).toBe(1);
  });

  it('shows nothing to a banned person, and drops a menu entry the moment its role is deactivated', async () => {
    const f = await world();
    const alice = f.user('alice');
    await f.give('alice', 'reader');
    expect((await f.axeda.menu(alice)).length).toBe(1);
    expect(await f.axeda.menu({ ...alice, banned: true })).toEqual([]);
    const reader = await f.persistence.roles.getByKey('reader');
    await f.axeda.roles.setStatus(f.admin, reader?.id ?? '', reader?.version ?? 0, 'inactive');
    expect(await f.axeda.menu(alice)).toEqual([]);
  });

  it('never shows an entry the person cannot actually use (menu and checks agree)', async () => {
    const f = await world();
    f.user('alice');
    await f.give('alice', 'analyst');
    const alice = { userId: 'alice' };
    const visible = (nodes: readonly MenuNode[]): MenuNode[] =>
      nodes.flatMap((n) => (n.children.length > 0 ? visible(n.children) : [n]));
    for (const leaf of visible(await f.axeda.menu(alice))) {
      const required = {
        '/reportes': 'report:read',
        '/personas': 'user:read',
        '/facturas': 'invoice:read',
      }[leaf.path ?? ''];
      expect(await f.axeda.can(alice, required ?? 'invoice:read')).toBe(true);
    }
  });
});
