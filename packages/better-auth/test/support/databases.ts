import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { BetterAuthOptions } from '@better-auth/core';
import Database from 'better-sqlite3';
import pg from 'pg';
import { closeAfterTest } from './cleanup.js';
import { createPgliteDialect } from './pglite-dialect.js';

/**
 * - `sqlite`: SQLite en memoria (una conexión).
 * - `postgres`: PostgreSQL dentro del proceso (PGlite; una conexión).
 * - `postgres-server`: un servidor PostgreSQL de verdad con un grupo de conexiones. Solo existe si
 *   se define `AXEDA_TEST_POSTGRES_URL`; el CI lo hace con un servicio de PostgreSQL.
 */
export type DatabaseKind = 'sqlite' | 'postgres' | 'postgres-server';

export const SERVER_URL: string | undefined = process.env['AXEDA_TEST_POSTGRES_URL'] || undefined;

/** Los tipos contra los que corren las pruebas en este entorno. */
export const databaseKinds: readonly DatabaseKind[] =
  SERVER_URL === undefined ? ['sqlite', 'postgres'] : ['sqlite', 'postgres', 'postgres-server'];

/** Conexiones del grupo del servidor real: más de una, para que haya paralelismo de verdad. */
export const SERVER_POOL_SIZE = 10;

export interface OpenedDatabase {
  readonly database: NonNullable<BetterAuthOptions['database']>;
  readonly sqlite: Database.Database | undefined;
}

/** Una base de datos PostgreSQL nueva en el servidor, que se borra al terminar la prueba. */
async function openServerDatabase(url: string): Promise<pg.Pool> {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  // El nombre sale de bytes aleatorios en hexadecimal: no hay nada que escapar.
  const name = `axeda_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: SERVER_POOL_SIZE });
  closeAfterTest(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  return pool;
}

/** Abre una base de datos nueva del tipo pedido y la cierra al terminar la prueba. */
export async function openDatabase(
  kind: DatabaseKind,
  options: { readonly foreignKeys?: boolean } = {},
): Promise<OpenedDatabase> {
  if (kind === 'sqlite') {
    const sqlite = new Database(':memory:');
    closeAfterTest(() => void sqlite.close());
    if (options.foreignKeys === false) sqlite.pragma('foreign_keys = OFF');
    return { database: sqlite, sqlite };
  }
  if (kind === 'postgres-server') {
    if (SERVER_URL === undefined) {
      throw new Error('AXEDA_TEST_POSTGRES_URL is not set; there is no PostgreSQL server to use.');
    }
    return { database: await openServerDatabase(SERVER_URL), sqlite: undefined };
  }
  const pglite = new PGlite();
  closeAfterTest(() => pglite.close());
  return {
    database: {
      dialect: createPgliteDialect(pglite),
      type: 'postgres' as const,
      transaction: true,
    },
    sqlite: undefined,
  };
}
