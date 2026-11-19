import { AxedaError } from '../errors.js';
import { writeAudit } from './audit.js';
import type { Services } from './services.js';

export interface AuditPurgeResult {
  /** Eventos borrados. */
  readonly removed: number;
  /** Se borró lo anterior a este instante. */
  readonly before: Date;
}

/** Eventos por lote: cada lote es una consulta corta, no una que bloquee la tabla entera. */
const BATCH = 500;

/**
 * Borra los eventos de auditoría con más de `retention.auditDays` días. Como `purgeDeleted()`, la
 * aplicación lo llama cuando quiera (p. ej. desde un cron); Axeda no corre tareas en segundo plano.
 * Va por lotes y fuera de transacción: si se interrumpe, lo borrado queda borrado y la siguiente
 * llamada sigue donde se quedó. Si borra algo, lo apunta en la propia auditoría.
 */
export async function purgeExpiredAudit(services: Services): Promise<AuditPurgeResult> {
  await services.ready();
  const { persistence, clock, options } = services;
  const days = options.retention.auditDays;
  if (days === null) {
    throw new AxedaError(
      'AXEDA_INVALID_CONFIG',
      'purgeAudit() needs retention.auditDays: without it the audit log is kept in full.',
    );
  }
  const before = new Date(clock.now().getTime() - days * 86_400_000);
  let removed = 0;
  for (;;) {
    const batch = await persistence.audit.deleteBefore(before, BATCH);
    removed += batch;
    if (batch < BATCH) break;
  }
  if (removed > 0) {
    await writeAudit(
      persistence,
      {
        actorId: null,
        action: 'audit.purge',
        targetType: 'system',
        targetId: null,
        scope: null,
        metadata: { before: before.toISOString(), removed, retentionDays: days },
      },
      'success',
    );
  }
  return { removed, before };
}
