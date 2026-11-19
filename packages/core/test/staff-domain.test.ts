import { describe, expect, it } from 'vitest';
import {
  USERNAME_PATTERN,
  generatePin,
  homeScopeOf,
  isStaffEmail,
  isWeakPin,
  normalizeUsername,
} from '../src/index.js';

describe('PINs', () => {
  it('refuses the PINs anyone would try first', () => {
    for (const pin of [
      '000000',
      '111111',
      '123456',
      '234567',
      '987654',
      '654321',
      '121212',
      '123123',
      '12341234',
      '1234567',
      '12345678',
      '90909090',
    ]) {
      expect(isWeakPin(pin), pin).toBe(true);
    }
    for (const pin of ['381946', '1029384', '73915206', '122333', '135792']) {
      expect(isWeakPin(pin), pin).toBe(false);
    }
  });

  it('generates PINs of the asked length, only digits, never weak', () => {
    for (const length of [6, 7, 8]) {
      for (let i = 0; i < 200; i++) {
        const pin = generatePin(length);
        expect(pin).toMatch(new RegExp(`^\\d{${length}}$`));
        expect(isWeakPin(pin)).toBe(false);
      }
    }
    expect(generatePin()).toHaveLength(6);
    for (const bad of [5, 9, 6.5]) expect(() => generatePin(bad)).toThrow(RangeError);
  });

  it('spreads the digits evenly (no modulo bias)', () => {
    const counts = Array.from({ length: 10 }, () => 0);
    for (let i = 0; i < 4000; i++) {
      for (const digit of generatePin(8)) counts[Number(digit)] = (counts[Number(digit)] ?? 0) + 1;
    }
    // 32 000 dígitos: cada uno ronda los 3 200. Un sesgo del 0–5 daría ~3 400 frente a ~2 900.
    for (const count of counts) expect(count).toBeGreaterThan(2900);
    for (const count of counts) expect(count).toBeLessThan(3500);
  });
});

describe('usernames', () => {
  it('accepts simple names and normalizes case and spaces', () => {
    expect(normalizeUsername('  Mesero.Uno ')).toBe('mesero.uno');
    for (const name of ['mesero1', 'ana_perez', 'cocina-2', 'j.lopez', 'abc']) {
      expect(USERNAME_PATTERN.test(name), name).toBe(true);
    }
    for (const name of ['ab', '-ana', 'ana-', 'ana perez', 'Ana', 'ñandú', 'a'.repeat(33), 'a@b']) {
      expect(USERNAME_PATTERN.test(name), name).toBe(false);
    }
  });
});

describe('staff accounts', () => {
  it('belong to the most specific place they were created in', () => {
    expect(homeScopeOf({ companyId: 'c', businessId: null, siteId: null })).toEqual({
      type: 'company',
      id: 'c',
    });
    expect(homeScopeOf({ companyId: 'c', businessId: 'b', siteId: null })).toEqual({
      type: 'business',
      id: 'b',
    });
    expect(homeScopeOf({ companyId: 'c', businessId: 'b', siteId: 's' })).toEqual({
      type: 'site',
      id: 's',
    });
  });

  it('recognizes the placeholder email', () => {
    expect(isStaffEmail('k3j2h1@staff.invalid')).toBe(true);
    expect(isStaffEmail('ana@acme.com')).toBe(false);
  });
});
