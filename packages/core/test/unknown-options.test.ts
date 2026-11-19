import { describe, expect, it } from 'vitest';
import { closestOption, isAxedaError, rejectUnknownOptions } from '../src/index.js';

const KNOWN = ['permissions', 'roles', 'invitationDelivery', 'publicIdentity', 'maxSessionAge'];

const errorOf = (run: () => void) => {
  try {
    run();
  } catch (caught) {
    return caught as Error & { details: Record<string, unknown> };
  }
  return null;
};

describe('unknown options', () => {
  it('accepts known options and anything that is not an object', () => {
    expect(() =>
      rejectUnknownOptions('axeda()', { permissions: [], roles: {} }, KNOWN),
    ).not.toThrow();
    expect(() => rejectUnknownOptions('axeda()', undefined, KNOWN)).not.toThrow();
  });

  it('refuses a typo, naming it and the option it probably meant', () => {
    const error = errorOf(() =>
      rejectUnknownOptions('axeda()', { permissions: [], invitationDelibery: {} }, KNOWN),
    );
    expect(isAxedaError(error, 'AXEDA_INVALID_CONFIG')).toBe(true);
    expect(error?.message).toContain('axeda(): unknown option "invitationDelibery".');
    expect(error?.message).toContain('Did you mean "invitationDelivery"?');
    expect(error?.details).toEqual({
      option: 'invitationDelibery',
      suggestion: 'invitationDelivery',
    });
  });

  it('does not guess when nothing is close', () => {
    const error = errorOf(() => rejectUnknownOptions('axeda()', { colour: 'red' }, KNOWN));
    expect(error?.message).not.toContain('Did you mean');
    expect(error?.message).toContain('Known options: permissions, roles');
    expect(error?.details).toEqual({ option: 'colour' });
  });

  it('suggests through case and small slips, never far-fetched matches', () => {
    expect(closestOption('PublicIdentity', KNOWN)).toBe('publicIdentity');
    expect(closestOption('maxSesionAge', KNOWN)).toBe('maxSessionAge');
    expect(closestOption('role', KNOWN)).toBe('roles');
    expect(closestOption('zzz', KNOWN)).toBeUndefined();
    expect(closestOption('permissionsList', KNOWN)).toBeUndefined();
  });
});
