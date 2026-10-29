/**
 * Medición de rendimiento de Axeda.
 *
 *   npm run bench                  contra SQLite en memoria (para probar el script)
 *   AXEDA_TEST_POSTGRES_URL=postgres://… npm run bench
 *                                  contra un PostgreSQL real con un grupo de 10 conexiones
 *   npm run bench -- --check       además falla si algo supera su presupuesto (bench/budgets.json)
 *   npm run bench -- --json salida.json
 *
 * Los presupuestos son TECHOS GENEROSOS para detectar regresiones grandes en el CI, no cifras
 * objetivo: los ejecutores compartidos del CI son ruidosos. Se ajustan con las cifras reales.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createAxeda, type Axeda, type AxedaPersistence } from '@axeda/core';
import {
  axeda,
  createBetterAuthPersistence,
  createBetterAuthUserDirectory,
} from '@axeda/better-auth';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import pg from 'pg';

const SERVER_URL = process.env['AXEDA_TEST_POSTGRES_URL'] || undefined;
const KIND = SERVER_URL === undefined ? 'sqlite' : 'postgres-server';
const POOL_SIZE = 10;
const USERS = 400;
const COMPANIES = 5;
const PERMISSIONS = ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'];

interface Stats {
  readonly scenario: string;
  readonly iterations: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly opsPerSecond: number;
  /** Consultas a la base de datos por llamada (solo donde se pueden contar). */
  readonly queriesPerCall: number | null;
}

const percentile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

function summarize(
  scenario: string,
  samples: number[],
  wallMs: number,
  queries: number | null,
): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    scenario,
    iterations: samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
    opsPerSecond: (samples.length / wallMs) * 1000,
    queriesPerCall: queries === null ? null : queries / samples.length,
  };
}

/** Una a una, midiendo cada llamada. */
async function sequential(
  scenario: string,
  iterations: number,
  call: (i: number) => Promise<unknown>,
  counter?: { n: number },
): Promise<Stats> {
  const samples: number[] = [];
  const before = counter?.n ?? 0;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await call(i);
    samples.push(performance.now() - t0);
  }
  const queries = counter === undefined ? null : counter.n - before;
  return summarize(scenario, samples, performance.now() - started, queries);
}

/** `concurrency` llamadas a la vez hasta completar `iterations`. */
async function concurrent(
  scenario: string,
  iterations: number,
  concurrency: number,
  call: (i: number) => Promise<unknown>,
): Promise<Stats> {
  const samples: number[] = [];
  let next = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    for (let i = next++; i < iterations; i = next++) {
      const t0 = performance.now();
      await call(i);
      samples.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return summarize(scenario, samples, performance.now() - started, null);
}

const QUERY_METHODS = new Set([
  'findOne',
  'findMany',
  'count',
  'create',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'incrementOne',
  'consumeOne',
]);

/** Cuenta las consultas que pasan por el adaptador (las de dentro de una transacción no). */
function counting<T extends object>(target: T, counter: { n: number }): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== 'function' || !QUERY_METHODS.has(String(property))) return value;
      return (...args: unknown[]) => {
        counter.n += 1;
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

type AuthOptions = Parameters<typeof betterAuth>[0];

async function openDatabase(): Promise<{
  database: NonNullable<AuthOptions['database']>;
  close: () => Promise<void>;
}> {
  if (SERVER_URL === undefined) {
    const sqlite = new Database(':memory:');
    return { database: sqlite, close: async () => void sqlite.close() };
  }
  const admin = new pg.Pool({ connectionString: SERVER_URL, max: 1 });
  const name = `axeda_bench_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(SERVER_URL);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: POOL_SIZE });
  return {
    database: pool,
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

interface Bench {
  readonly core: Axeda;
  readonly persistence: AxedaPersistence;
  readonly counter: { n: number };
  readonly companyIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
  readonly close: () => Promise<void>;
}

async function prepare(): Promise<Bench> {
  const { database, close } = await openDatabase();
  const plugin = axeda({ permissions: PERMISSIONS });
  const options = {
    secret: 'bench-secret-bench-secret-bench-secret-012345',
    baseURL: 'http://localhost:3000',
    database,
    emailAndPassword: { enabled: true },
    plugins: [plugin],
    rateLimit: { enabled: false },
  } satisfies AuthOptions;
  await (await getMigrations(options)).runMigrations();
  const context = await betterAuth(options).$context;

  const counter = { n: 0 };
  const persistence = createBetterAuthPersistence(counting(context.adapter, counter));
  const core = createAxeda(
    { permissions: PERMISSIONS },
    { persistence, users: createBetterAuthUserDirectory(context.adapter) },
  );

  const now = new Date();
  const userIds = Array.from({ length: USERS }, (_, i) => `bench-user-${i}`);
  for (const id of ['bench-admin', ...userIds]) {
    await context.adapter.create({
      model: 'user',
      forceAllowId: true,
      data: {
        id,
        name: id,
        email: `${id}@bench.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  await core.start();
  await core.bootstrap({ userId: 'bench-admin' });
  const admin = { userId: 'bench-admin' };

  const companyIds: string[] = [];
  for (let i = 0; i < COMPANIES; i++) {
    companyIds.push((await core.companies.create(admin, { slug: `bench-${i}`, name: `B${i}` })).id);
  }
  const roleIds: string[] = [];
  for (const [key, permissions] of Object.entries({
    reader: ['invoice:read'],
    cashier: ['invoice:read', 'invoice:create'],
    manager: ['invoice:*'],
    reports: ['report:read'],
  })) {
    roleIds.push((await core.roles.create(admin, { key, name: key, permissions })).id);
  }
  // Cada persona tiene una función en cada compañía: 5 asignaciones, como una persona real.
  for (const [u, userId] of userIds.entries()) {
    for (const [c, companyId] of companyIds.entries()) {
      await persistence.assignments.create({
        userId,
        roleId: roleIds[(u + c) % roleIds.length] ?? '',
        scope: { type: 'company', id: companyId },
        grantedBy: null,
      });
    }
  }
  return { core, persistence, counter, companyIds, roleIds, userIds, close };
}

async function run(b: Bench): Promise<Stats[]> {
  const results: Stats[] = [];
  const target = (i: number) => ({
    type: 'company' as const,
    companyId: b.companyIds[i % b.companyIds.length] ?? '',
  });
  const check = (userId: string, i: number) => b.core.can({ userId }, 'invoice:read', target(i));
  const user0 = b.userIds[0] ?? '';

  // 1. Caliente: la misma persona, una y otra vez.
  await check(user0, 0);
  results.push(await sequential('can() warm cache', 2000, (i) => check(user0, i), b.counter));

  // 1b. Caliente, como en una aplicación real: Better Auth ya entrega la versión del usuario.
  results.push(
    await sequential(
      'can() warm cache, version from the session',
      2000,
      (i) => b.core.can({ userId: user0, authzVersion: 0 }, 'invoice:read', target(i)),
      b.counter,
    ),
  );

  // 2. Fría: cada persona por primera vez (nada en la caché).
  results.push(
    await sequential(
      'can() cold cache',
      b.userIds.length,
      (i) => check(b.userIds[i] ?? '', i),
      b.counter,
    ),
  );

  // 3. Invalidación masiva: editar una función que tienen todos y volver a preguntar.
  const admin = { userId: 'bench-admin' };
  const role = await b.core.roles.get(admin, b.roleIds[0] ?? '');
  const t0 = performance.now();
  await b.core.roles.update(admin, role.id, role.version, { description: 'edited by the bench' });
  const editMs = performance.now() - t0;
  results.push(
    await sequential(
      'can() after a role edit (all users miss)',
      b.userIds.length,
      (i) => check(b.userIds[i] ?? '', i),
      b.counter,
    ),
  );
  console.log(`  (the role edit itself took ${editMs.toFixed(1)} ms)`);

  // 4. Administración bajo carga: conceder funciones a la vez.
  for (const [level, concurrency] of [1, 4, 16].entries()) {
    const users = b.userIds.slice(level * 100, level * 100 + 100);
    results.push(
      await concurrent(
        `assignments.assign, ${concurrency} at a time`,
        users.length,
        concurrency,
        (i) =>
          b.core.assignments.assign(admin, {
            userId: users[i] ?? '',
            roleId: b.roleIds[3] ?? '',
            scope: { type: 'global' },
          }),
      ),
    );
  }
  return results;
}

function print(results: readonly Stats[]): void {
  const cell = (value: number | null, digits = 2) => (value === null ? '—' : value.toFixed(digits));
  console.log(
    `\nDatabase: ${KIND}${KIND === 'sqlite' ? ' (in memory)' : ` (pool of ${POOL_SIZE})`}`,
  );
  console.log(
    'scenario'.padEnd(46),
    'n'.padStart(6),
    'p50 ms'.padStart(9),
    'p95 ms'.padStart(9),
    'p99 ms'.padStart(9),
    'ops/s'.padStart(9),
    'queries'.padStart(8),
  );
  for (const r of results) {
    console.log(
      r.scenario.padEnd(46),
      String(r.iterations).padStart(6),
      cell(r.p50).padStart(9),
      cell(r.p95).padStart(9),
      cell(r.p99).padStart(9),
      cell(r.opsPerSecond, 0).padStart(9),
      cell(r.queriesPerCall, 1).padStart(8),
    );
  }
}

type Budgets = Record<string, Record<string, { p95Ms: number }>>;

/** Los escenarios que superan su presupuesto de p95. */
function overBudget(results: readonly Stats[]): string[] {
  const budgets = JSON.parse(
    readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'),
  ) as Budgets;
  const own = budgets[KIND];
  if (own === undefined) throw new Error(`bench/budgets.json has no budgets for "${KIND}".`);
  return results.flatMap((r) => {
    const budget = own[r.scenario]?.p95Ms;
    if (budget === undefined) return [`${r.scenario}: no budget declared`];
    return r.p95 > budget ? [`${r.scenario}: p95 ${r.p95.toFixed(2)} ms > ${budget} ms`] : [];
  });
}

const bench = await prepare();
let failures: string[] = [];
try {
  const results = await run(bench);
  print(results);
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex >= 0) {
    writeFileSync(
      process.argv[jsonIndex + 1] ?? 'bench-results.json',
      JSON.stringify({ kind: KIND, results }, null, 2),
    );
  }
  if (process.argv.includes('--check')) failures = overBudget(results);
} finally {
  await bench.close();
}
if (failures.length > 0) {
  console.error(`\nOver budget:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else if (process.argv.includes('--check')) {
  console.log('\nAll scenarios are within their budgets.');
}
