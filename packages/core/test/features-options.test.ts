import { describe, expect, it } from 'vitest';
import { resolveOptions, type AxedaOptions } from '../src/index.js';

const base = { permissions: ['inventory:read', 'inventory:write', 'invoice:read'] };
const resolve = (features: NonNullable<AxedaOptions['features']>) =>
  resolveOptions({ ...base, features });

describe('declaring features', () => {
  it('resolves names, permissions and the default, off unless said otherwise', () => {
    const { features } = resolve({
      inventory: { permissions: ['inventory:*'], name: 'Inventory' },
      reports: { permissions: ['invoice:read'], enabledByDefault: true },
    });
    expect(features.get('inventory')).toEqual({
      key: 'inventory',
      name: 'Inventory',
      description: null,
      permissions: ['inventory:*'],
      enabledByDefault: false,
    });
    expect(features.get('reports')?.enabledByDefault).toBe(true);
    expect(resolveOptions(base).features.size).toBe(0);
  });

  it('refuses keys, permissions and fields that are wrong', () => {
    const bad: NonNullable<AxedaOptions['features']>[] = [
      { Inventory: { permissions: ['inventory:read'] } },
      { inventory: { permissions: [] } },
      { inventory: { permissions: ['stock:read'] } },
      // La administración de Axeda no se apaga por plan, ni con un comodín.
      { inventory: { permissions: ['axeda:assignment:manage'] } },
      { inventory: { permissions: ['*'] } },
      { inventory: { permissions: ['inventory:read'], enabled: true } as never },
    ];
    for (const features of bad) {
      expect(() => resolve(features), JSON.stringify(features)).toThrow(/Invalid Axeda options/);
    }
  });
});
