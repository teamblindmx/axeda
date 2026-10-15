/** Códigos de error estables de Axeda. El texto puede cambiar; el código no. */
export type AxedaErrorCode =
  | 'AXEDA_INVALID_PERMISSION'
  | 'AXEDA_UNKNOWN_PERMISSION'
  | 'AXEDA_INVALID_CONFIG'
  | 'AXEDA_TRANSACTIONS_UNSUPPORTED'
  | 'AXEDA_ROLE_NOT_FOUND'
  | 'AXEDA_ROLE_KEY_TAKEN'
  | 'AXEDA_VERSION_CONFLICT'
  | 'AXEDA_ASSIGNMENT_EXISTS'
  | 'AXEDA_USER_NOT_FOUND'
  | 'AXEDA_DATA_CORRUPT';

export class AxedaError extends Error {
  readonly code: AxedaErrorCode;

  constructor(code: AxedaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AxedaError';
    this.code = code;
  }
}

export function isAxedaError(error: unknown, code?: AxedaErrorCode): error is AxedaError {
  return error instanceof AxedaError && (code === undefined || error.code === code);
}
