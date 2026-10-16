import type { AssignmentScope } from './scope.js';

/** Acciones auditadas. Se amplía con cada fase; los valores existentes no cambian. */
export type AuditAction =
  | 'role.create'
  | 'role.update'
  | 'role.set_status'
  | 'role.delete'
  | 'role.sync'
  | 'assignment.create'
  | 'assignment.revoke'
  | 'user.delete'
  | 'company.create'
  | 'company.update'
  | 'company.set_status'
  | 'company.delete'
  | 'company.restore'
  | 'company.purge'
  | 'business.create'
  | 'business.update'
  | 'business.set_status'
  | 'business.delete'
  | 'business.restore'
  | 'business.purge'
  | 'invitation.create'
  | 'invitation.accept'
  | 'invitation.revoke'
  | 'bootstrap';

export type AuditOutcome = 'success' | 'denied';

export type AuditTargetType =
  'role' | 'assignment' | 'user' | 'company' | 'business' | 'invitation' | 'system';

export interface AuditEvent {
  readonly id: string;
  readonly at: Date;
  /** `null` para operaciones del sistema (arranque, `bootstrap`). */
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string | null;
  /** Alcance en el que ocurre; `null` si no aplica. */
  readonly scope: AssignmentScope | null;
  readonly outcome: AuditOutcome;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Detalles pequeños y sin secretos (se limita su tamaño). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type NewAuditEvent = Omit<AuditEvent, 'id' | 'at'>;

/** Tamaño máximo de `metadata` serializado (S12). */
export const MAX_AUDIT_METADATA_BYTES = 2048;

/**
 * Generador de identificadores de auditoría que ordenan cronológicamente como cadenas:
 * milisegundos, un contador (estrictamente creciente dentro del proceso, aunque el reloj
 * retroceda o dos eventos caigan en el mismo milisegundo) y un UUID para evitar colisiones
 * entre procesos.
 */
export function createAuditIdFactory(): (at: Date) => string {
  let lastMillis = 0;
  let sequence = 0;
  return (at) => {
    const millis = Math.max(at.getTime(), lastMillis);
    sequence = millis === lastMillis ? sequence + 1 : 0;
    lastMillis = millis;
    return `${millis.toString(36).padStart(9, '0')}${sequence.toString(36).padStart(4, '0')}-${globalThis.crypto.randomUUID()}`;
  };
}
