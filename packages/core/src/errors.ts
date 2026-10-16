/** Códigos de error estables de Axeda. El texto puede cambiar; el código no. */
export type AxedaErrorCode =
  | 'AXEDA_INVALID_PERMISSION'
  | 'AXEDA_UNKNOWN_PERMISSION'
  | 'AXEDA_INVALID_CONFIG'
  | 'AXEDA_INVALID_INPUT'
  | 'AXEDA_TRANSACTIONS_UNSUPPORTED'
  | 'AXEDA_ROLE_NOT_FOUND'
  | 'AXEDA_ROLE_KEY_TAKEN'
  | 'AXEDA_ROLE_MANAGED'
  | 'AXEDA_VERSION_CONFLICT'
  | 'AXEDA_ASSIGNMENT_EXISTS'
  | 'AXEDA_ASSIGNMENT_NOT_FOUND'
  | 'AXEDA_USER_NOT_FOUND'
  | 'AXEDA_MFA_REQUIRED'
  | 'AXEDA_LIMIT_EXCEEDED'
  | 'AXEDA_FORBIDDEN'
  | 'AXEDA_ALREADY_BOOTSTRAPPED'
  | 'AXEDA_DATA_CORRUPT';

export interface AxedaErrorOptions {
  readonly cause?: unknown;
  /** Datos para quien llama (p. ej. el motivo de una denegación). Nunca secretos. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AxedaError extends Error {
  readonly code: AxedaErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: AxedaErrorCode, message: string, options: AxedaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AxedaError';
    this.code = code;
    this.details = options.details ?? {};
  }
}

export function isAxedaError(error: unknown, code?: AxedaErrorCode): error is AxedaError {
  return error instanceof AxedaError && (code === undefined || error.code === code);
}
