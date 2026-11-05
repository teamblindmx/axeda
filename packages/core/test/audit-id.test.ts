import { describe, expect, it } from 'vitest';
import { AUDIT_ID_LENGTH, createAuditIdFactory } from '../src/domain/audit.js';

const at = (millis: number) => new Date(millis);
const T0 = Date.UTC(2026, 0, 1);

describe('audit event ids', () => {
  it('fit in the id column of Better Auth on MySQL: exactly 36 characters', () => {
    const next = createAuditIdFactory();
    expect(AUDIT_ID_LENGTH).toBe(36);
    for (let i = 0; i < 50; i += 1) expect(next(at(T0 + i))).toHaveLength(AUDIT_ID_LENGTH);
  });

  it('use only digits, lowercase letters and one dash, so a case-insensitive database orders them the same', () => {
    const next = createAuditIdFactory();
    for (let i = 0; i < 50; i += 1) expect(next(at(T0))).toMatch(/^[0-9a-z]{13}-[0-9a-f]{22}$/);
  });

  it('sort strictly by time as strings, also within one millisecond and when the clock goes back', () => {
    const next = createAuditIdFactory();
    const times = [T0, T0, T0, T0 + 1, T0 - 5_000, T0 + 2, T0 + 36 ** 3, T0 + 36 ** 4];
    const ids = times.map((time) => next(at(time)));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('do not collide between two processes writing at the same millisecond', () => {
    const first = createAuditIdFactory();
    const second = createAuditIdFactory();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      ids.add(first(at(T0)));
      ids.add(second(at(T0)));
    }
    expect(ids.size).toBe(400);
  });

  it('keep their order however large the counter grows within one millisecond', () => {
    const next = createAuditIdFactory();
    const ids = Array.from({ length: 2_000 }, () => next(at(T0)));
    ids.push(next(at(T0 + 1)));
    expect([...ids].sort()).toEqual(ids);
  });
});
