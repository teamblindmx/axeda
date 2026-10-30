import { APIError } from 'better-auth/api';
import { isAxedaError, type AxedaErrorCode } from '@teamblind/axeda-core';

type Status = ConstructorParameters<typeof APIError>[0];

/**
 * Estado HTTP de CADA código estable. El mapa es exhaustivo a propósito: al añadir un código en el
 * núcleo, el compilador obliga a decidir aquí qué responde la API (antes, un código olvidado
 * acababa en un 500 sin que nadie lo notara). `'internal'` significa «error del servidor, sin
 * detalles»: son fallos de configuración o de datos que el cliente no puede arreglar.
 */
const STATUS: Record<AxedaErrorCode, Status | 'internal'> = {
  AXEDA_INVALID_INPUT: 'BAD_REQUEST',
  AXEDA_INVALID_PERMISSION: 'BAD_REQUEST',
  AXEDA_UNKNOWN_PERMISSION: 'BAD_REQUEST',
  AXEDA_INVITATION_INVALID: 'BAD_REQUEST',
  AXEDA_FORBIDDEN: 'FORBIDDEN',
  AXEDA_MFA_REQUIRED: 'FORBIDDEN',
  AXEDA_ROLE_NOT_FOUND: 'NOT_FOUND',
  AXEDA_ASSIGNMENT_NOT_FOUND: 'NOT_FOUND',
  AXEDA_USER_NOT_FOUND: 'NOT_FOUND',
  AXEDA_EMAIL_TAKEN: 'CONFLICT',
  AXEDA_COMPANY_NOT_FOUND: 'NOT_FOUND',
  AXEDA_BUSINESS_NOT_FOUND: 'NOT_FOUND',
  AXEDA_ROLE_KEY_TAKEN: 'CONFLICT',
  AXEDA_ROLE_MANAGED: 'CONFLICT',
  AXEDA_VERSION_CONFLICT: 'CONFLICT',
  AXEDA_ASSIGNMENT_EXISTS: 'CONFLICT',
  AXEDA_LIMIT_EXCEEDED: 'CONFLICT',
  AXEDA_ALREADY_BOOTSTRAPPED: 'CONFLICT',
  AXEDA_SLUG_TAKEN: 'CONFLICT',
  AXEDA_INVITATION_EXISTS: 'CONFLICT',
  AXEDA_FEATURE_DISABLED: 'NOT_IMPLEMENTED',
  AXEDA_DELIVERY_FAILED: 'BAD_GATEWAY',
  AXEDA_INVALID_CONFIG: 'internal',
  AXEDA_TRANSACTIONS_UNSUPPORTED: 'internal',
  AXEDA_DATA_CORRUPT: 'internal',
};

/** Los códigos que la API traduce a un estado concreto (para las pruebas). */
export const MAPPED_CODES = Object.keys(STATUS) as AxedaErrorCode[];

/**
 * Convierte un error de Axeda en una respuesta de Better Auth con el código estable `AXEDA_*`.
 *
 * Solo los errores que se espera ver (validación, permisos, conflictos) llevan su mensaje al
 * cliente. Cualquier otro (base de datos caída, datos corruptos, un fallo inesperado) devuelve
 * un 500 genérico: el detalle puede revelar el esquema o la infraestructura (S17).
 */
export function toApiError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  if (isAxedaError(error)) {
    const status = STATUS[error.code];
    if (status !== 'internal') {
      return new APIError(status, { code: error.code, message: error.message });
    }
  }
  return new APIError('INTERNAL_SERVER_ERROR', {
    code: 'AXEDA_INTERNAL_ERROR',
    message: 'Internal error.',
  });
}
