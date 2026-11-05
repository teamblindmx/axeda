import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { BetterAuthOptions } from '@better-auth/core';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { MongoClient } from 'mongodb';
import {
  createPool as createMysqlPool,
  type Pool as MysqlPool,
  type RowDataPacket,
} from 'mysql2/promise';
import pg from 'pg';
import { closeAfterTest } from './cleanup.js';
import { createPgliteDialect } from './pglite-dialect.js';

/**
 * - `sqlite`: SQLite en memoria (una conexión).
 * - `postgres`: PostgreSQL dentro del proceso (PGlite; una conexión).
 * - `postgres-server`: un servidor PostgreSQL de verdad con un grupo de conexiones. Solo existe si
 *   se define `AXEDA_TEST_POSTGRES_URL`; el CI lo hace con un servicio de PostgreSQL.
 * - `mysql-server`: un servidor MySQL de verdad con un grupo de conexiones. Solo existe si se
 *   define `AXEDA_TEST_MYSQL_URL`; el CI lo hace con un servicio de MySQL.
 * - `mongo-server`: un conjunto de réplicas de MongoDB de verdad (las transacciones lo exigen). Solo
 *   existe si se define `AXEDA_TEST_MONGO_URL`.
 */
export type DatabaseKind =
  'sqlite' | 'postgres' | 'postgres-server' | 'mysql-server' | 'mongo-server';

export const SERVER_URL: string | undefined = process.env['AXEDA_TEST_POSTGRES_URL'] || undefined;
export const MYSQL_URL: string | undefined = process.env['AXEDA_TEST_MYSQL_URL'] || undefined;
export const MONGO_URL: string | undefined = process.env['AXEDA_TEST_MONGO_URL'] || undefined;

/** Los tipos contra los que corren las pruebas en este entorno. */
export const databaseKinds: readonly DatabaseKind[] = [
  'sqlite',
  'postgres',
  ...(SERVER_URL === undefined ? [] : (['postgres-server'] as const)),
  ...(MYSQL_URL === undefined ? [] : (['mysql-server'] as const)),
  ...(MONGO_URL === undefined ? [] : (['mongo-server'] as const)),
];

/** Conexiones del grupo del servidor real: más de una, para que haya paralelismo de verdad. */
export const SERVER_POOL_SIZE = 10;

export interface OpenedDatabase {
  readonly database: NonNullable<BetterAuthOptions['database']>;
  /** Opciones de Better Auth que esta base de datos necesita (casi siempre ninguna). */
  readonly options: Partial<BetterAuthOptions>;
  readonly sqlite: Database.Database | undefined;
}

/**
 * Borra la base de datos DESPUÉS de que el servidor confirme que no quedan conexiones a ella.
 * `pool.end()` resuelve antes de que el servidor cierre de verdad los sockets; si se borra con
 * `FORCE` en ese hueco, el servidor mata conexiones que aún se estaban cerrando y el cliente
 * recibe un error (57P01) sin nadie que lo escuche. Esperar evita el aviso; `FORCE` queda solo
 * como último recurso si algo se queda colgado.
 */
async function dropWhenQuiet(admin: pg.Pool, name: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    if (rows[0]?.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
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
  // Un error de una conexión ociosa (p. ej. el servidor reiniciándose) no debe tumbar el proceso.
  pool.on('error', () => {});
  closeAfterTest(async () => {
    await pool.end();
    await dropWhenQuiet(admin, name);
    await admin.end();
  });
  return pool;
}

/**
 * Una base de datos MySQL nueva en el servidor, que se borra al terminar la prueba.
 *
 * Better Auth espera el grupo de `mysql2/promise` (no el de `mysql2`). `timezone: 'Z'`: sin esto el
 * controlador convierte las fechas a la hora local de quien ejecuta, y un servidor con otra zona (o
 * un cambio de horario) las desplaza. Es lo que debe poner también quien use MySQL con Axeda.
 */
async function openMysqlDatabase(
  url: string,
): Promise<{ readonly database: MysqlPool; readonly options: Partial<BetterAuthOptions> }> {
  const admin = createMysqlPool({ uri: url, connectionLimit: 1 });
  const [settings] = await admin.query<RowDataPacket[]>(
    'SELECT @@lower_case_table_names AS lowerCaseTableNames',
  );
  // El nombre sale de bytes aleatorios en hexadecimal: no hay nada que escapar.
  const name = `axeda_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = createMysqlPool({
    uri: target.toString(),
    connectionLimit: SERVER_POOL_SIZE,
    timezone: 'Z',
  });
  pool.pool.on('error', () => {});
  closeAfterTest(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  // Un servidor que guarda los nombres de tabla en minúsculas (Windows, macOS) hace que Better Auth
  // dé por faltantes las tablas `axedaRole`…: se apaga solo esa comprobación (ver la referencia).
  const lowercaseTables = Number(settings?.[0]?.['lowerCaseTableNames'] ?? 0) !== 0;
  return {
    database: pool,
    options: lowercaseTables ? { advanced: { database: { validateSchema: false } } } : {},
  };
}

/** Una base de datos MongoDB nueva en el conjunto de réplicas, que se borra al terminar la prueba. */
async function openMongoDatabase(url: string): Promise<OpenedDatabase['database']> {
  const client = new MongoClient(url, { maxPoolSize: SERVER_POOL_SIZE });
  await client.connect();
  // El nombre sale de bytes aleatorios en hexadecimal: no hay nada que escapar.
  const db = client.db(`axeda_test_${randomBytes(8).toString('hex')}`);
  closeAfterTest(async () => {
    await db.dropDatabase();
    await client.close();
  });
  return mongodbAdapter(db, { client });
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
    return { database: sqlite, sqlite, options: {} };
  }
  if (kind === 'mongo-server') {
    if (MONGO_URL === undefined) {
      throw new Error('AXEDA_TEST_MONGO_URL is not set; there is no MongoDB server to use.');
    }
    return { database: await openMongoDatabase(MONGO_URL), sqlite: undefined, options: {} };
  }
  if (kind === 'mysql-server') {
    if (MYSQL_URL === undefined) {
      throw new Error('AXEDA_TEST_MYSQL_URL is not set; there is no MySQL server to use.');
    }
    return { ...(await openMysqlDatabase(MYSQL_URL)), sqlite: undefined };
  }
  if (kind === 'postgres-server') {
    if (SERVER_URL === undefined) {
      throw new Error('AXEDA_TEST_POSTGRES_URL is not set; there is no PostgreSQL server to use.');
    }
    return { database: await openServerDatabase(SERVER_URL), sqlite: undefined, options: {} };
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
    options: {},
  };
}

/**
 * Crea las tablas del esquema. MongoDB no tiene migraciones en Better Auth (`getMigrations` solo
 * entiende Kysely y termina el proceso): su adaptador crea las colecciones y los índices la primera
 * vez que las usa, así que ahí no hay nada que ejecutar.
 */
export async function migrate(kind: DatabaseKind, options: BetterAuthOptions): Promise<void> {
  if (kind === 'mongo-server') return;
  await (await getMigrations(options)).runMigrations();
}
