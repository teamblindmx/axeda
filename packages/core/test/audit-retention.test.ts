import { describe, expect, it } from 'vitest';
import { isAxedaError, resolveOptions } from '../src/index.js';
import { createFixture } from './fixture.js';

const DAY = 86_400_000;

describe('audit retention', () => {
  it('deletes the events older than retention.auditDays and keeps the recent ones', async () => {
    const f = await createFixture({ permissions: ['a:b'], retention: { auditDays: 30 } });
    // El arranque dejó el evento de `bootstrap`; luego, uno 20 días después.
    await f.role('old', ['a:b']);
    f.clock.current = new Date(f.clock.current.getTime() + 20 * DAY);
    await f.role('recent', ['a:b']);
    f.clock.current = new Date(f.clock.current.getTime() + 15 * DAY);

    const result = await f.axeda.purgeAudit();
    expect(result).toEqual({
      removed: 2,
      before: new Date(f.clock.current.getTime() - 30 * DAY),
    });
    const left = await f.axeda.listAudit(f.admin, {}, { limit: 10 });
    expect(left.items.map((event) => [event.action, event.targetType, event.actorId])).toEqual([
      // Lo que borra queda apuntado, como del sistema.
      ['audit.purge', 'system', null],
      ['role.create', 'role', 'admin'],
    ]);
    expect(left.items[0]?.metadata).toEqual({
      before: result.before.toISOString(),
      removed: 2,
      retentionDays: 30,
    });
  });

  it('deletes in batches until nothing old is left', async () => {
    const f = await createFixture({ permissions: ['a:b'], retention: { auditDays: 1 } });
    for (let index = 0; index < 1200; index += 1) {
      await f.persistence.audit.append({
        actorId: 'admin',
        action: 'role.update',
        targetType: 'role',
        targetId: String(index),
        scope: null,
        outcome: 'success',
        ip: null,
        userAgent: null,
        metadata: {},
      });
    }
    f.clock.current = new Date(f.clock.current.getTime() + 2 * DAY);
    // 1200 de antes más el de `bootstrap`: tres lotes.
    expect((await f.axeda.purgeAudit()).removed).toBe(1201);
  });

  it('writes nothing when there is nothing to delete', async () => {
    const f = await createFixture({ permissions: ['a:b'], retention: { auditDays: 30 } });
    expect((await f.axeda.purgeAudit()).removed).toBe(0);
    const events = await f.axeda.listAudit(f.admin, {}, { limit: 10 });
    expect(events.items.map((event) => event.action)).toEqual(['bootstrap']);
  });

  it('refuses to run without retention.auditDays, so nothing is deleted by accident', async () => {
    const f = await createFixture({ permissions: ['a:b'] });
    const error = await f.axeda.purgeAudit().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isAxedaError(error, 'AXEDA_INVALID_CONFIG')).toBe(true);
    expect((error as Error).message).toContain('retention.auditDays');
  });

  it('accepts whole days from 1, and nothing else', () => {
    expect(resolveOptions({ permissions: [], retention: { auditDays: 1 } }).retention).toEqual({
      graceDays: 30,
      auditDays: 1,
    });
    expect(resolveOptions({ permissions: [] }).retention.auditDays).toBeNull();
    for (const auditDays of [0, -1, 1.5, 40_000]) {
      expect(
        () => resolveOptions({ permissions: [], retention: { auditDays } }),
        String(auditDays),
      ).toThrow(/auditDays/);
    }
  });
});
