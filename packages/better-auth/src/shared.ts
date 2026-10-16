import type { DBAdapter, DBTransactionAdapter } from '@better-auth/core/db/adapter';

export type Adapter = DBAdapter | DBTransactionAdapter;

/** Ejecuta `work` de forma atómica con el adaptador que corresponda. */
export type Atomic = <T>(work: (adapter: Adapter) => Promise<T>) => Promise<T>;

export const encodeCursor = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');
export const decodeCursor = (cursor: string): string =>
  Buffer.from(cursor, 'base64url').toString('utf8');

export const byId = (id: string) => [{ field: 'id', value: id }];

/**
 * Better Auth limita `findMany` a 100 filas si no se indica otra cosa. Para datos de seguridad
 * un tope silencioso es peligroso, así que siempre se pide un límite explícito.
 */
export const MAX_ROWS = 10_000;
