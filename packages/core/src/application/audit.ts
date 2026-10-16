import {
  MAX_AUDIT_METADATA_BYTES,
  type AuditAction,
  type AuditTargetType,
} from '../domain/audit.js';
import type { RequestMeta } from '../domain/role.js';
import type { AssignmentScope } from '../domain/scope.js';
import { isAxedaError } from '../errors.js';
import type { AxedaPersistence, AxedaStores } from '../ports/persistence.js';

const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 255;

export interface AuditDraft {
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string | null;
  readonly scope?: AssignmentScope | null;
  readonly meta?: RequestMeta | undefined;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Acota el tamaño de `metadata` (S12): si se pasa, se guarda una marca en lugar del contenido. */
function boundedMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const text = JSON.stringify(metadata);
  if (text.length <= MAX_AUDIT_METADATA_BYTES) return { ...metadata };
  return { truncated: true, originalBytes: text.length };
}

const clip = (value: string | undefined, max: number): string | null =>
  value === undefined || value.length === 0 ? null : value.slice(0, max);

/** Escribe un evento. Dentro de una transacción, queda atado a ella: o ambos, o ninguno. */
export async function writeAudit(
  stores: Pick<AxedaStores, 'audit'>,
  draft: AuditDraft,
  outcome: 'success' | 'denied',
): Promise<void> {
  await stores.audit.append({
    actorId: draft.actorId,
    action: draft.action,
    targetType: draft.targetType,
    targetId: draft.targetId,
    scope: draft.scope ?? null,
    outcome,
    ip: clip(draft.meta?.ip, MAX_IP_LENGTH),
    userAgent: clip(draft.meta?.userAgent, MAX_USER_AGENT_LENGTH),
    metadata: boundedMetadata(draft.metadata ?? {}),
  });
}

/** Errores de denegación que deben quedar en la auditoría aunque la transacción se deshaga. */
const deniedErrors = new WeakSet<Error>();

export function markDenied<T extends Error>(error: T): T {
  deniedErrors.add(error);
  return error;
}

/**
 * Ejecuta `operation` y, si lanza una denegación marcada, la audita **aparte**: la transacción
 * que hubiera escrito el registro ya se deshizo, y el intento no puede perderse.
 */
export async function auditDenials<T>(
  persistence: AxedaPersistence,
  draft: AuditDraft,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && deniedErrors.has(error)) {
      const reason = isAxedaError(error) ? error.details['reason'] : undefined;
      await writeAudit(
        persistence,
        { ...draft, metadata: { ...draft.metadata, ...(reason === undefined ? {} : { reason }) } },
        'denied',
      );
    }
    throw error;
  }
}

/** `auditDenials` sobre una transacción: si se deniega, no queda nada del intento. */
export function runAudited<T>(
  persistence: AxedaPersistence,
  draft: AuditDraft,
  work: (stores: AxedaStores) => Promise<T>,
): Promise<T> {
  return auditDenials(persistence, draft, () => persistence.transaction(work));
}
