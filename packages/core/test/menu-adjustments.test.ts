import { describe, expect, it } from 'vitest';
import { buildMenu } from '../src/application/menu.js';
import { applyMenuAdjustments, PermissionSet, resolveOptions } from '../src/index.js';

const { menus } = resolveOptions({
  permissions: ['invoice:read', 'report:read', 'stock:read'],
  menus: [
    { key: 'sales', label: { es: 'Ventas', en: 'Sales' }, order: 1 },
    {
      key: 'invoices',
      parent: 'sales',
      label: 'Invoices',
      path: '/invoices',
      requires: 'invoice:read',
      order: 1,
    },
    {
      key: 'reports',
      parent: 'sales',
      label: 'Reports',
      path: '/reports',
      requires: 'report:read',
      order: 2,
    },
    { key: 'stock', label: 'Stock', path: '/stock', requires: 'stock:read', order: 2 },
  ],
});
const everything = new PermissionSet(['*'] as never);
const shape = (menu: typeof menus) =>
  buildMenu(menu, everything, 'es').map((node) => [
    node.key,
    node.label,
    node.children.map((child) => child.key),
  ]);
const none = { hidden: null, order: null, labels: null };

describe('adjusting the menu declared in code', () => {
  it('changes nothing without adjustments', () => {
    expect(applyMenuAdjustments(menus, [])).toBe(menus);
    expect(shape(menus)).toEqual([
      ['sales', 'Ventas', ['invoices', 'reports']],
      ['stock', 'Stock', []],
    ]);
  });

  it('hides an item and everything under it', () => {
    const hiddenGroup = applyMenuAdjustments(menus, [
      [{ ...none, itemKey: 'sales', hidden: true }],
    ]);
    expect(shape(hiddenGroup)).toEqual([['stock', 'Stock', []]]);
    const hiddenLeaf = applyMenuAdjustments(menus, [
      [{ ...none, itemKey: 'reports', hidden: true }],
    ]);
    expect(shape(hiddenLeaf)).toEqual([
      ['sales', 'Ventas', ['invoices']],
      ['stock', 'Stock', []],
    ]);
  });

  it('reorders siblings and renames, per language', () => {
    const result = applyMenuAdjustments(menus, [
      [
        { ...none, itemKey: 'stock', order: 0 },
        { ...none, itemKey: 'reports', order: 0 },
        { ...none, itemKey: 'sales', labels: { es: 'Caja', en: 'Till' } },
      ],
    ]);
    expect(shape(result)).toEqual([
      ['stock', 'Stock', []],
      ['sales', 'Caja', ['reports', 'invoices']],
    ]);
  });

  it('lets the company layer win field by field over the global one', () => {
    const result = applyMenuAdjustments(menus, [
      [{ itemKey: 'stock', hidden: true, order: 5, labels: { '*': 'Almacén' } }],
      [{ ...none, itemKey: 'stock', hidden: false }],
    ]);
    expect(shape(result)).toEqual([
      ['sales', 'Ventas', ['invoices', 'reports']],
      ['stock', 'Almacén', []],
    ]);
  });

  it('ignores adjustments of items no longer in the code', () => {
    expect(
      shape(applyMenuAdjustments(menus, [[{ ...none, itemKey: 'gone', hidden: true }]])),
    ).toEqual(shape(menus));
  });
});
