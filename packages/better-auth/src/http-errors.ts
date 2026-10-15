import { APIError } from 'better-auth/api';
import { isAxedaError, type AxedaErrorCode } from '@axeda/core';

type Status = ConstructorParameters<typeof APIError>[0];

/** Estado HTTP de cada código estable. Lo que no está aquí es un error interno (500). */
const STATUS: Partial<Record<AxedaErrorCode, Status>> = {
  AXEDA_INVALID_INPUT: 'BAD_REQUEST',
  AXEDA_INVALID_PERMISSION: 'BAD_REQUEST',
  AXEDA_UNKNOWN_PERMISSION: 'BAD_REQUEST',
  AXEDA_FORBIDDEN: 'FORBIDDEN',
  AXEDA_MFA_REQUIRED: 'FORBIDDEN',
  AXEDA_ROLE_NOT_FOUND: 'NOT_FOUND',
  AXEDA_ASSIGNMENT_NOT_FOUND: 'NOT_FOUND',
  AXEDA_USER_NOT_FOUND: 'NOT_FOUND',
  AXEDA_ROLE_KEY_TAKEN: 'CONFLICT',
  AXEDA_ROLE_MANAGED: 'CONFLICT',
  AXEDA_VERSION_CONFLICT: 'CONFLICT',
  AXEDA_ASSIGNMENT_EXISTS: 'CONFLICT',
  AXEDA_LIMIT_EXCEEDED: 'CONFLICT',
  AXEDA_ALREADY_BOOTSTRAPPED: 'CONFLICT',
};

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
    if (status !== undefined)
      return new APIError(status, { code: error.code, message: error.message });
  }
  return new APIError('INTERNAL_SERVER_ERROR', {
    code: 'AXEDA_INTERNAL_ERROR',
    message: 'Internal error.',
  });
}
