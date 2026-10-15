import type { PGlite } from '@electric-sql/pglite';
import { PostgresDialect, type PostgresPoolClient } from 'kysely';

/**
 * Dialecto de Kysely para PGlite (PostgreSQL real compilado a WASM, sin Docker).
 *
 * PGlite tiene una sola conexión: cada `connect()` espera a que se libere la anterior, igual
 * que un grupo de tamaño 1. Así, una transacción no se mezcla con consultas de otras
 * peticiones, que es lo que haría un servidor de verdad con conexiones separadas.
 */
export function createPgliteDialect(db: PGlite): PostgresDialect {
  let tail: Promise<void> = Promise.resolve();
  let release: () => void = () => undefined;

  const client = {
    processID: 1,
    // Kysely también admite cursores (streaming); aquí solo se usan consultas normales.
    query: (async (sql: string, parameters?: readonly unknown[]) => {
      const result = await db.query(sql, parameters === undefined ? [] : [...parameters]);
      const verb = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
      const command: 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT' =
        verb === 'INSERT' || verb === 'UPDATE' || verb === 'DELETE' ? verb : 'SELECT';
      return { command, rowCount: result.affectedRows ?? result.rows.length, rows: result.rows };
    }) as PostgresPoolClient['query'],
    release: () => release(),
  };

  const pool = {
    options: {},
    async connect() {
      const previous = tail;
      let unlock: () => void = () => undefined;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      release = unlock;
      return client;
    },
    end: () => db.close(),
  };

  return new PostgresDialect({ pool });
}
