/**
 * Medición de rendimiento de Axeda.
 *
 *   npm run bench                  contra SQLite en memoria (para probar el script)
 *   AXEDA_TEST_POSTGRES_URL=postgres://… npm run bench
 *                                  contra un PostgreSQL real con un grupo de 10 conexiones
 *   npm run bench -- --check       además falla si algo supera su presupuesto (bench/budgets.json)
 *   npm run bench -- --json salida.json
 *   AXEDA_BENCH_AUDIT_ROWS=100000 npm run bench   más filas de auditoría (por defecto 20 000)
 *
 * Mide cuatro cosas: la comprobación de permisos (`can`), el coste de una ruta con alcance
 * (resolver la compañía o el negocio y luego decidir), los listados paginados con volumen
 * (auditoría y asignaciones de un alcance) y las escrituras de sesión por petición.
 *
 * Los presupuestos son de dos clases. La de latencia (`p95Ms`) son TECHOS GENEROSOS para detectar
 * regresiones grandes: los ejecutores compartidos del CI son ruidosos, y se ajustan con las cifras
 * reales. La de consultas (`maxQueries`, por llamada) no depende del ruido de la máquina: es el
 * mejor guardia contra un viaje de más a la base de datos.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  createAxeda,
  type Axeda,
  type AuditFilter,
  type AxedaPersistence,
  type NewAuditEvent,
} from '@teamblind/axeda-core';
import {
  axeda,
  createBetterAuthPersistence,
  createBetterAuthUserDirectory,
} from '@teamblind/axeda-better-auth';
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
const AUDIT_ROWS = Number(process.env['AXEDA_BENCH_AUDIT_ROWS'] ?? 20_000);
/** Personas distintas que reparten la otra mitad de los eventos de auditoría. */
const AUDIT_ACTORS = 40;
const DAY_MS = 86_400_000;
const NAME_WIDTH = 66;
/**
 * Holgura de `maxQueries`. El promedio incluye el calentamiento (la primera vez que se resuelve
 * cada compañía o negocio), así que no sale entero; una regresión real es de una consulta entera.
 */
const QUERY_SLACK = 0.05;

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

/**
 * Una a una, midiendo cada llamada. `prepare` corre antes de cada una y fuera de la medición (su
 * tiempo no cuenta, aunque sus consultas sí pasarían por el contador si las hiciera por él).
 */
async function sequential(
  scenario: string,
  iterations: number,
  call: (i: number) => Promise<unknown>,
  counter?: { n: number },
  prepare?: (i: number) => Promise<void>,
): Promise<Stats> {
  const samples: number[] = [];
  const before = counter?.n ?? 0;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    if (prepare !== undefined) await prepare(i);
    const t0 = performance.now();
    await call(i);
    samples.push(performance.now() - t0);
  }
  const queries = counter === undefined ? null : counter.n - before;
  // Con preparación, las operaciones por segundo se cuentan sobre el tiempo medido, no el total.
  const wallMs =
    prepare === undefined ? performance.now() - started : samples.reduce((a, b) => a + b, 0);
  return summarize(scenario, samples, wallMs, queries);
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

/** Borra la base de datos cuando el servidor confirma que no quedan conexiones (ver las pruebas). */
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

type AuthOptions = Parameters<typeof betterAuth>[0];

async function openDatabase(): Promise<{
  database: NonNullable<AuthOptions['database']>;
  /**
   * Calcula las estadísticas del planificador. Se llama justo después de sembrar los datos: una tabla
   * recién cargada no las tiene, y hasta que el motor las calcula por su cuenta elige planes que no
   * son los de un sistema en marcha (la misma consulta pasó de 0,8 ms a 13 ms entre ejecuciones del CI).
   */
  analyze: () => Promise<void>;
  close: () => Promise<void>;
}> {
  if (SERVER_URL === undefined) {
    const sqlite = new Database(':memory:');
    return {
      database: sqlite,
      analyze: async () => void sqlite.exec('ANALYZE'),
      close: async () => void sqlite.close(),
    };
  }
  const admin = new pg.Pool({ connectionString: SERVER_URL, max: 1 });
  const name = `axeda_bench_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(SERVER_URL);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: POOL_SIZE });
  pool.on('error', () => {});
  return {
    database: pool,
    analyze: async () => {
      await pool.query('ANALYZE');
      // Si no quedaron estadísticas (reltuples sigue en -1), el benchmark mediría otra cosa.
      const { rows } = await pool.query<{ reltuples: number }>(
        `SELECT reltuples FROM pg_class WHERE relname = 'axedaAudit'`,
      );
      if ((rows[0]?.reltuples ?? -1) < 0) {
        throw new Error(
          'ANALYZE left no statistics on "axedaAudit"; the lists would be planned blind.',
        );
      }
    },
    close: async () => {
      await pool.end();
      await dropWhenQuiet(admin, name);
      await admin.end();
    },
  };
}

/** Lo mínimo de Better Auth que usa la medición de sesiones (los tipos genéricos no encajan). */
interface SessionAuth {
  readonly api: {
    signUpEmail(input: {
      body: { email: string; password: string; name: string };
      asResponse: true;
    }): Promise<Response>;
    getSession(input: { headers: Headers }): Promise<unknown>;
  };
}

interface SessionContext {
  readonly adapter: {
    findOne<T>(input: {
      model: string;
      where: Array<{ field: string; value: string }>;
    }): Promise<T | null>;
    update(input: {
      model: string;
      where: Array<{ field: string; value: string }>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  readonly internalAdapter: { updateSession(...args: never[]): Promise<unknown> };
}

/** Una sesión real de Better Auth para medir cuántas veces se escribe por petición. */
interface BenchSession {
  readonly auth: SessionAuth;
  readonly adapter: SessionContext['adapter'];
  readonly userId: string;
  readonly headers: Headers;
  /** Llamadas a `internalAdapter.updateSession`: cada una es una escritura de la sesión. */
  readonly writes: { n: number };
}

interface Bench {
  readonly core: Axeda;
  readonly persistence: AxedaPersistence;
  readonly counter: { n: number };
  readonly companyIds: readonly string[];
  readonly businessIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
  /** Asignaciones que hay en el alcance de la primera compañía. */
  readonly scopeSize: number;
  readonly session: BenchSession;
  readonly close: () => Promise<void>;
}

/** Corre `work` sobre `items` en tandas de `size` a la vez. */
async function inBatches<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work));
  }
}

/**
 * Eventos de auditoría de volumen: la mitad de una misma persona (como un administrador
 * activo), la otra mitad repartida entre otras, una de cada cinco con alcance de compañía, y unos
 * pocos de una acción rara para medir el filtro por acción.
 */
async function seedAudit(
  persistence: AxedaPersistence,
  companyIds: readonly string[],
): Promise<void> {
  const base = { outcome: 'success', ip: null, userAgent: null, metadata: {} } as const;
  const common = Array.from({ length: AUDIT_ROWS }, (_, i): NewAuditEvent => ({
    ...base,
    actorId: i % 2 === 0 ? 'bench-admin' : `bench-user-${i % AUDIT_ACTORS}`,
    action: i % 3 === 0 ? 'role.update' : 'assignment.create',
    targetType: 'assignment',
    targetId: `bench-target-${i}`,
    scope: i % 5 === 0 ? { type: 'company', id: companyIds[i % companyIds.length] ?? '' } : null,
  }));
  const rare = Array.from({ length: 5 }, (_, i): NewAuditEvent => ({
    ...base,
    actorId: null,
    action: 'company.purge',
    targetType: 'company',
    targetId: `bench-purged-${i}`,
    scope: null,
  }));
  // Los raros van PRIMERO: son los más antiguos, y el listado va del más nuevo al más viejo. Si fueran
  // los últimos, el listado los encontraría al instante y no mediría lo que cuesta buscar una acción
  // que ocurrió hace tiempo.
  await inBatches([...rare, ...common], 20, (event) => persistence.audit.append(event));
}

async function openSession(auth: SessionAuth, context: SessionContext): Promise<BenchSession> {
  const response = await auth.api.signUpEmail({
    body: { email: 'bench-session@bench.dev', password: 'bench-password-12345', name: 'bench' },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const { user } = (await response.json()) as { user: { id: string } };
  const writes = { n: 0 };
  const internal = context.internalAdapter;
  const original = internal.updateSession.bind(internal);
  (internal as { updateSession: unknown }).updateSession = (...args: never[]) => {
    writes.n += 1;
    return original(...args);
  };
  return {
    auth,
    adapter: context.adapter,
    userId: user.id,
    headers: new Headers({ cookie }),
    writes,
  };
}

async function prepare(): Promise<Bench> {
  const { database, analyze, close } = await openDatabase();
  const plugin = axeda({ permissions: PERMISSIONS });
  const options = {
    secret: 'bench-secret-bench-secret-bench-secret-012345',
    baseURL: 'http://localhost:3000',
    database,
    emailAndPassword: { enabled: true },
    // Los valores del preset: siete días sin uso, renovada como mucho una vez al día.
    session: { expiresIn: 7 * 86_400, updateAge: 86_400 },
    plugins: [plugin],
    rateLimit: { enabled: false },
  } satisfies AuthOptions;
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  const context = await auth.$context;

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
  // Un negocio en cada compañía, para medir las rutas con alcance de negocio.
  const businessIds: string[] = [];
  for (const companyId of companyIds) {
    businessIds.push(
      (await core.businesses.create(admin, companyId, { slug: 'shop', name: 'Shop' })).id,
    );
  }
  // La primera compañía acumula todas las funciones de todas las personas: un alcance grande.
  const firstCompany = companyIds[0] ?? '';
  const extra = userIds.flatMap((userId, u) =>
    [1, 2, 3].map((k) => ({ userId, roleId: roleIds[(u + k) % roleIds.length] ?? '' })),
  );
  await inBatches(extra, 20, (input) =>
    persistence.assignments.create({
      ...input,
      scope: { type: 'company', id: firstCompany },
      grantedBy: null,
    }),
  );
  await seedAudit(persistence, companyIds);
  const session = await openSession(
    auth as unknown as SessionAuth,
    context as unknown as SessionContext,
  );
  await analyze();
  return {
    core,
    persistence,
    counter,
    companyIds,
    businessIds,
    roleIds,
    userIds,
    scopeSize: userIds.length * roleIds.length,
    session,
    close,
  };
}

/**
 * Lo que cuesta una RUTA con alcance, no solo `can()`: resolver la compañía o el negocio en la base
 * de datos (nunca se confía en el identificador que llega) y después decidir. Con la sesión
 * entregando la versión del usuario, es lo que paga cada petición a una ruta protegida.
 */
async function routeScenarios(b: Bench): Promise<Stats[]> {
  const principal = { userId: b.userIds[1] ?? '', authzVersion: 0 };
  const route = (type: 'company' | 'business', ids: readonly string[]) => async (i: number) => {
    const target = await b.core.resolveTarget({ type, id: ids[i % ids.length] ?? '' });
    if (target === null) throw new Error('the bench scope does not resolve');
    return b.core.can(principal, 'invoice:read', target);
  };
  const company = route('company', b.companyIds);
  const business = route('business', b.businessIds);
  await company(0);
  await business(0);
  return [
    await sequential('route: resolveTarget + can(), company scope', 1000, company, b.counter),
    await sequential('route: resolveTarget + can(), business scope', 1000, business, b.counter),
  ];
}

/** Listados paginados con volumen: la auditoría y las asignaciones de un alcance grande. */
async function listScenarios(b: Bench): Promise<Stats[]> {
  const page = { limit: 50 };
  const audit = (filter: AuditFilter) => () => b.persistence.audit.list(filter, page);
  const scope = { type: 'company', id: b.companyIds[0] ?? '' } as const;
  return [
    await sequential('audit.list, no filter', 200, audit({}), b.counter),
    await sequential(
      'audit.list, by an actor with half the rows',
      200,
      audit({ actorId: 'bench-admin' }),
      b.counter,
    ),
    await sequential(
      'audit.list, by a rare action',
      200,
      audit({ action: 'company.purge' }),
      b.counter,
    ),
    await sequential(
      `assignments.listForScope, ${b.scopeSize.toLocaleString('en-US')} in the scope`,
      200,
      () => b.persistence.assignments.listForScope(scope, page),
      b.counter,
    ),
  ];
}

/**
 * Escrituras de sesión por petición. Se deja la fila de la sesión como estaría tras cierta edad
 * (sin esperar días de verdad) y se mide Better Auth leyéndola: el valor de la columna de consultas
 * es el número de veces que se escribió la sesión por petición, no de lecturas.
 *
 * A mitad de vida, la primera petición del día renueva y las demás no. En el último tramo, el
 * límite absoluto impide que la caducidad avance y Better Auth renueva en cada petición.
 */
async function sessionScenarios(b: Bench): Promise<Stats[]> {
  const { auth, adapter, userId, headers, writes } = b.session;
  const DAILY = 10;
  const where = [{ field: 'userId', value: userId }];
  const reseed = (ageDays: number) => async (i: number) => {
    if (i % DAILY !== 0) return;
    const now = Date.now();
    const createdAt = new Date(now - ageDays * DAY_MS);
    // Renovada por última vez hace dos días: tocaría renovarla hoy.
    const lastRefresh = now - 2 * DAY_MS;
    const expiresAt = Math.min(lastRefresh + 7 * DAY_MS, createdAt.getTime() + 30 * DAY_MS);
    await adapter.update({
      model: 'session',
      where,
      update: { createdAt, updatedAt: new Date(lastRefresh), expiresAt: new Date(expiresAt) },
    });
  };
  const read = () => auth.api.getSession({ headers });
  return [
    await sequential(
      `session: ${DAILY} requests a day, mid-life (queries = session writes)`,
      100,
      read,
      writes,
      reseed(10),
    ),
    await sequential(
      `session: ${DAILY} requests a day, last stretch (queries = session writes)`,
      100,
      read,
      writes,
      reseed(25),
    ),
  ];
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
  results.push(...(await routeScenarios(b)));
  results.push(...(await listScenarios(b)));
  results.push(...(await sessionScenarios(b)));
  return results;
}

function print(results: readonly Stats[]): void {
  const cell = (value: number | null, digits = 2) => (value === null ? '—' : value.toFixed(digits));
  console.log(
    `\nDatabase: ${KIND}${KIND === 'sqlite' ? ' (in memory)' : ` (pool of ${POOL_SIZE})`}`,
  );
  console.log(
    'scenario'.padEnd(NAME_WIDTH),
    'n'.padStart(6),
    'p50 ms'.padStart(9),
    'p95 ms'.padStart(9),
    'p99 ms'.padStart(9),
    'ops/s'.padStart(9),
    'queries'.padStart(8),
  );
  for (const r of results) {
    console.log(
      r.scenario.padEnd(NAME_WIDTH),
      String(r.iterations).padStart(6),
      cell(r.p50).padStart(9),
      cell(r.p95).padStart(9),
      cell(r.p99).padStart(9),
      cell(r.opsPerSecond, 0).padStart(9),
      cell(r.queriesPerCall, 1).padStart(8),
    );
  }
}

/** `p95Ms`: techo de latencia. `maxQueries`: techo exacto de consultas por llamada. Basta uno. */
type Budgets = Record<string, Record<string, { p95Ms?: number; maxQueries?: number }>>;

/** Los escenarios que superan su presupuesto de p95. */
function overBudget(results: readonly Stats[]): string[] {
  const budgets = JSON.parse(
    readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'),
  ) as Budgets;
  const own = budgets[KIND];
  if (own === undefined) throw new Error(`bench/budgets.json has no budgets for "${KIND}".`);
  return results.flatMap((r) => {
    const budget = own[r.scenario];
    if (budget === undefined || (budget.p95Ms === undefined && budget.maxQueries === undefined)) {
      return [`${r.scenario}: no budget declared`];
    }
    const over: string[] = [];
    if (budget.p95Ms !== undefined && r.p95 > budget.p95Ms) {
      over.push(`${r.scenario}: p95 ${r.p95.toFixed(2)} ms > ${budget.p95Ms} ms`);
    }
    if (
      budget.maxQueries !== undefined &&
      r.queriesPerCall !== null &&
      r.queriesPerCall > budget.maxQueries + QUERY_SLACK
    ) {
      over.push(
        `${r.scenario}: ${r.queriesPerCall.toFixed(2)} queries per call > ${budget.maxQueries}`,
      );
    }
    return over;
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
