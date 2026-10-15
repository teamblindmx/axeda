import { describe, expect, it } from 'vitest';
import {
  AXEDA_CATALOG,
  DEFAULT_LIMITS,
  isAxedaError,
  resolveOptions,
  type AxedaOptions,
} from '../src/index.js';
import { keys } from './helpers.js';

const valid: AxedaOptions = {
  permissions: ['invoice:create', 'invoice:read', 'invoice:delete'],
  roles: {
    cashier: ['invoice:create', 'invoice:read'],
    viewer: {
      name: 'Viewer',
      description: 'Read only',
      permissions: ['invoice:read'],
      requireMfa: true,
    },
    invoicing: ['invoice:*'],
  },
};

const expectInvalid = (options: unknown, fragment: string) => {
  try {
    resolveOptions(options as AxedaOptions);
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(isAxedaError(error, 'AXEDA_INVALID_CONFIG')).toBe(true);
    expect((error as Error).message).toContain(fragment);
  }
};

describe('resolveOptions', () => {
  it('builds the catalog from the application permissions plus the Axeda ones', () => {
    const resolved = resolveOptions(valid);
    expect(resolved.catalog).toEqual([
      ...AXEDA_CATALOG,
      ...keys('invoice:create', 'invoice:read', 'invoice:delete'),
    ]);
  });

  it('resolves role definitions with defaults', () => {
    const { roles } = resolveOptions(valid);
    expect(roles.get('cashier')).toEqual({
      key: 'cashier',
      name: 'cashier',
      description: null,
      permissions: keys('invoice:create', 'invoice:read'),
      requireMfa: false,
    });
    expect(roles.get('viewer')).toMatchObject({
      name: 'Viewer',
      description: 'Read only',
      requireMfa: true,
    });
  });

  it('accepts a wildcard that covers part of the catalog', () => {
    expect(resolveOptions(valid).roles.get('invoicing')?.permissions).toEqual(keys('invoice:*'));
  });

  it('accepts the total wildcard in a role', () => {
    const resolved = resolveOptions({ permissions: ['a:b'], roles: { root: ['*'] } });
    expect(resolved.roles.get('root')?.permissions).toEqual(keys('*'));
  });

  it('removes duplicate permissions inside a role', () => {
    const resolved = resolveOptions({ permissions: ['a:b'], roles: { r: ['a:b', 'a:b'] } });
    expect(resolved.roles.get('r')?.permissions).toEqual(keys('a:b'));
  });

  it('applies the default limits and accepts overrides', () => {
    expect(resolveOptions(valid).limits).toEqual(DEFAULT_LIMITS);
    const custom = resolveOptions({ permissions: [], limits: { maxAssignmentsPerUser: 5 } });
    expect(custom.limits).toEqual({ ...DEFAULT_LIMITS, maxAssignmentsPerUser: 5 });
  });

  it('works with no roles and no application permissions', () => {
    const resolved = resolveOptions({ permissions: [] });
    expect(resolved.catalog).toEqual(AXEDA_CATALOG);
    expect(resolved.roles.size).toBe(0);
  });
});

describe('resolveOptions rejects mistakes at startup', () => {
  it.each([
    ['an invalid permission key', { permissions: ['Invoice:Read'] }, 'Invoice:Read'],
    ['a wildcard in the catalog', { permissions: ['invoice:*'] }, 'wildcard'],
    ['a permission using the reserved prefix', { permissions: ['axeda:custom'] }, 'reserved'],
    ['a duplicated permission', { permissions: ['a:b', 'a:b'] }, 'twice'],
    [
      'a role using a permission that is not in the catalog (typo)',
      { permissions: ['invoice:read'], roles: { r: ['invoice:raed'] } },
      'matches no permission',
    ],
    [
      'a wildcard that covers nothing',
      { permissions: ['invoice:read'], roles: { r: ['order:*'] } },
      'matches no permission',
    ],
    ['an empty role', { permissions: ['a:b'], roles: { r: [] } }, 'no permissions'],
    ['an invalid role key', { permissions: ['a:b'], roles: { 'Bad Key': ['a:b'] } }, 'role key'],
    [
      'too many permissions in a role',
      {
        permissions: ['a:b', 'a:c'],
        roles: { r: ['a:b', 'a:c'] },
        limits: { maxPermissionsPerRole: 1 },
      },
      'more than 1',
    ],
    ['an unknown option', { permissions: [], extra: true }, 'extra'],
    ['permissions that are not an array', { permissions: 'a:b' }, 'permissions'],
    [
      'a non-integer limit',
      { permissions: [], limits: { maxAssignmentsPerUser: 1.5 } },
      'maxAssignmentsPerUser',
    ],
    [
      'a zero limit',
      { permissions: [], limits: { maxPermissionsPerRole: 0 } },
      'maxPermissionsPerRole',
    ],
    [
      'an unknown key inside a role definition',
      { permissions: ['a:b'], roles: { r: { permissions: ['a:b'], surprise: 1 } } },
      'surprise',
    ],
    ['missing options', undefined, 'root'],
  ])('%s', (_label, options, fragment) => {
    expectInvalid(options, fragment);
  });
});
