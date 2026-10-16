export interface Page<T> {
  readonly items: readonly T[];
  /** Cursor opaco para pedir la página siguiente; `null` si no hay más. */
  readonly nextCursor: string | null;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string | undefined;
}
