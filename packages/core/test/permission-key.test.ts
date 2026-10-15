import { describe, expect, it } from 'vitest';
import {
  AxedaError,
  covers,
  isPermissionKey,
  isWildcard,
  parsePermissionKey,
  permissionKeyProblem,
} from '../src/index.js';
import { k } from './helpers.js';

describe('permission key grammar', () => {
  it.each([
    'invoice:create',
    'axeda:role:manage',
    'invoice:*',
    'axeda:*',
    '*',
    'a-b:c_d',
    'a1:b2:c3',
  ])('accepts %s', (key) => {
    expect(permissionKeyProblem(key)).toBeNull();
    expect(isPermissionKey(key)).toBe(true);
    expect(parsePermissionKey(key)).toBe(key);
  });

  it.each([
    ['empty string', ''],
    ['single segment', 'invoice'],
    ['four segments', 'a:b:c:d'],
    ['uppercase', 'Invoice:read'],
    ['empty first segment', ':read'],
    ['empty last segment', 'invoice:'],
    ['wildcard inside a segment', 'inv*:read'],
    ['wildcard as first segment', '*:read'],
    ['wildcard in the middle', 'invoice:*:read'],
    ['double wildcard', 'invoice:**'],
    ['space', 'invoice: create'],
    ['segment starting with a digit', '1abc:read'],
    ['segment longer than 32 chars', `${'a'.repeat(33)}:read`],
    ['dot separator', 'invoice.create'],
    ['trailing newline', 'invoice:create\n'],
  ])('rejects %s', (_label, key) => {
    expect(permissionKeyProblem(key)).not.toBeNull();
    expect(isPermissionKey(key)).toBe(false);
    expect(() => parsePermissionKey(key)).toThrow(AxedaError);
  });

  it('reports AXEDA_INVALID_PERMISSION', () => {
    expect(() => parsePermissionKey('nope')).toThrow(
      expect.objectContaining({ code: 'AXEDA_INVALID_PERMISSION' }),
    );
  });

  it('rejects non-strings', () => {
    expect(isPermissionKey(42)).toBe(false);
    expect(isPermissionKey(null)).toBe(false);
    expect(isPermissionKey(undefined)).toBe(false);
  });

  it('knows which keys are wildcards', () => {
    expect(isWildcard(k('invoice:*'))).toBe(true);
    expect(isWildcard(k('*'))).toBe(true);
    expect(isWildcard(k('invoice:read'))).toBe(false);
  });
});

describe('covers (what a held permission grants)', () => {
  it.each([
    ['*', 'invoice:read', true],
    ['*', 'axeda:role:manage', true],
    ['*', '*', true],
    ['invoice:read', 'invoice:read', true],
    ['invoice:read', 'invoice:create', false],
    ['invoice:read', 'invoice:*', false],
    ['invoice:read', '*', false],
    ['invoice:*', 'invoice:read', true],
    ['invoice:*', 'invoice:*', true],
    ['invoice:*', 'invoice:read:draft', true],
    ['invoice:*', 'invoice:read:*', true],
    ['invoice:*', 'order:read', false],
    ['invoice:*', 'invoices:read', false],
    ['invoice:*', '*', false],
    ['axeda:*', 'axeda:role:manage', true],
    ['axeda:role:*', 'axeda:role:manage', true],
    ['axeda:role:*', 'axeda:user:manage', false],
    ['axeda:role:manage', 'axeda:role:*', false],
    ['inv:*', 'invoice:read', false],
  ])('covers(%s, %s) = %s', (held, required, expected) => {
    expect(covers(k(held), k(required))).toBe(expected);
  });
});
