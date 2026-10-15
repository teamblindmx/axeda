import type { BetterAuthOptions } from '@better-auth/core';
import type { DBAdapter, DBTransactionAdapter } from '@better-auth/core/db/adapter';
import {
  AxedaError,
  type AssignmentStore,
  type AuthzStateStore,
  type AxedaPersistence,
  type AxedaStores,
  type NewAssignment,
  type NewRole,
  type Page,
  type PageRequest,
  type Role,
  type RoleAssignment,
  type RoleChanges,
  type RoleStore,
} from '@axeda/core';
import { isForeignKeyViolation, isUniqueViolation } from './errors.js';
import { scopeColumns, toAssignment, toRole, type AssignmentRow, type RoleRow } from './rows.js';
import { MODELS, POLICY_STATE_KEY } from './schema.js';

type Adapter = DBAdapter | DBTransactionAdapter;

/** Ejecuta `work` de forma atómica con el adaptador que corresponda. */
type Atomic = <T>(work: (adapter: Adapter) => Promise<T>) => Promise<T>;

export interface BetterAuthPersistenceOptions {
  /** Reloj para `createdAt` y `updatedAt`. Por defecto, la hora del sistema. */
  readonly now?: () => Date;
}

/**
 * Better Auth limita `findMany` a 100 filas si no se indica otra cosa. Para datos de seguridad
 * un tope silencioso es peligroso, así que siempre se pide un límite explícito.
 */
const MAX_ASSIGNMENTS_READ = 1_000;

const encodeCursor = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString('utf8');

const byId = (id: string) => [{ field: 'id', value: id }];

function createRoleStore(adapter: Adapter, atomic: Atomic, now: () => Date): RoleStore {
  const model = MODELS.role;

  const find = async (id: string): Promise<RoleRow | null> =>
    adapter.findOne<RoleRow>({ model, where: byId(id) });

  return {
    async get(id) {
      const row = await find(id);
      return row ? toRole(row) : null;
    },

    async getMany(ids) {
      if (ids.length === 0) return [];
      const rows = await adapter.findMany<RoleRow>({
        model,
        where: [{ field: 'id', operator: 'in', value: [...ids] }],
        limit: ids.length,
      });
      return rows.map(toRole);
    },

    async getByKey(key) {
      const row = await adapter.findOne<RoleRow>({ model, where: [{ field: 'key', value: key }] });
      return row ? toRole(row) : null;
    },

    async list(page: PageRequest): Promise<Page<Role>> {
      const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
      const rows = await adapter.findMany<RoleRow>({
        model,
        ...(after === null ? {} : { where: [{ field: 'key', operator: 'gt', value: after }] }),
        sortBy: { field: 'key', direction: 'asc' },
        limit: page.limit + 1,
      });
      const items = rows.slice(0, page.limit).map(toRole);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > page.limit && last ? encodeCursor(last.key) : null,
      };
    },

    async create(input: NewRole) {
      const taken = () =>
        new AxedaError('AXEDA_ROLE_KEY_TAKEN', `A role with key "${input.key}" already exists.`);
      if (await adapter.findOne({ model, where: [{ field: 'key', value: input.key }] })) {
        throw taken();
      }
      const at = now();
      try {
        const row = await adapter.create<Omit<RoleRow, 'id'>, RoleRow>({
          model,
          data: {
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            permissions: [...input.permissions],
            requireMfa: input.requireMfa ?? false,
            status: input.status ?? 'active',
            managed: input.managed ?? false,
            version: 1,
            createdAt: at,
            updatedAt: at,
          },
        });
        return toRole(row);
      } catch (error) {
        // Otra petición creó la misma clave entre la comprobación y la inserción.
        if (isUniqueViolation(error)) throw taken();
        throw error;
      }
    },

    async update(id: string, expectedVersion: number, changes: RoleChanges) {
      // `incrementOne` usa la versión como guarda dentro de la propia sentencia: de dos
      // escritores con la misma versión, solo uno la cumple. `update` no ofrece esa garantía.
      const updated = await adapter.incrementOne<RoleRow>({
        model,
        where: [
          { field: 'id', value: id },
          { field: 'version', value: expectedVersion },
        ],
        increment: { version: 1 },
        set: {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.permissions === undefined ? {} : { permissions: [...changes.permissions] }),
          ...(changes.requireMfa === undefined ? {} : { requireMfa: changes.requireMfa }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
          updatedAt: now(),
        },
      });
      if (updated) return toRole(updated);

      const current = await find(id);
      if (!current) throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${id}" does not exist.`);
      throw new AxedaError(
        'AXEDA_VERSION_CONFLICT',
        `Role "${id}" is at version ${current.version}, not ${expectedVersion}.`,
      );
    },

    delete: (id: string) =>
      // Las claves foráneas ya lo harían en SQL, pero MongoDB no las tiene: se hace explícito.
      atomic(async (trx) => {
        await trx.deleteMany({ model: MODELS.assignment, where: [{ field: 'roleId', value: id }] });
        const removed = await trx.consumeOne<RoleRow>({ model, where: byId(id) });
        return removed !== null;
      }),
  };
}

function createAssignmentStore(adapter: Adapter, now: () => Date): AssignmentStore {
  const model = MODELS.assignment;

  return {
    async listForUser(userId) {
      const rows = await adapter.findMany<AssignmentRow>({
        model,
        where: [{ field: 'userId', value: userId }],
        sortBy: { field: 'createdAt', direction: 'asc' },
        limit: MAX_ASSIGNMENTS_READ,
      });
      return rows.map(toAssignment);
    },

    countForUser: (userId) => adapter.count({ model, where: [{ field: 'userId', value: userId }] }),

    async create(input: NewAssignment): Promise<RoleAssignment> {
      const missingRole = () =>
        new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${input.roleId}" does not exist.`);
      const exists = () =>
        new AxedaError('AXEDA_ASSIGNMENT_EXISTS', 'The user already has that role in that scope.');
      const columns = scopeColumns(input.scope);

      if (!(await adapter.findOne({ model: MODELS.role, where: byId(input.roleId) }))) {
        throw missingRole();
      }
      const duplicate = await adapter.findOne({
        model,
        where: [
          { field: 'userId', value: input.userId },
          { field: 'roleId', value: input.roleId },
          { field: 'scopeType', value: columns.scopeType },
          { field: 'scopeId', value: columns.scopeId },
        ],
      });
      if (duplicate) throw exists();

      try {
        const row = await adapter.create<Omit<AssignmentRow, 'id'>, AssignmentRow>({
          model,
          data: {
            userId: input.userId,
            roleId: input.roleId,
            ...columns,
            grantedBy: input.grantedBy ?? null,
            createdAt: now(),
            expiresAt: input.expiresAt ?? null,
          },
        });
        return toAssignment(row);
      } catch (error) {
        // Carreras entre la comprobación y la inserción.
        if (isUniqueViolation(error)) throw exists();
        if (isForeignKeyViolation(error)) throw missingRole();
        throw error;
      }
    },

    async revoke(id) {
      return (await adapter.consumeOne({ model, where: byId(id) })) !== null;
    },

    deleteForUser: (userId) =>
      adapter.deleteMany({ model, where: [{ field: 'userId', value: userId }] }),
  };
}

type UserVersionRow = { authzVersion?: number | null };
type StateRow = { version: number };

function createAuthzStore(adapter: Adapter, ensurePolicyRow: () => Promise<void>): AuthzStateStore {
  const policyWhere = [{ field: 'key', value: POLICY_STATE_KEY }];

  return {
    async getUserVersion(userId) {
      const row = await adapter.findOne<UserVersionRow>({
        model: 'user',
        where: byId(userId),
        select: ['authzVersion'],
      });
      return row?.authzVersion ?? 0;
    },

    async bumpUserVersion(userId) {
      // Atómico: leer, sumar y escribir pierde incrementos concurrentes (ADR-0009).
      const row = await adapter.incrementOne<UserVersionRow>({
        model: 'user',
        where: byId(userId),
        increment: { authzVersion: 1 },
      });
      if (!row) throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${userId}" does not exist.`);
      if (typeof row.authzVersion !== 'number') {
        throw new AxedaError(
          'AXEDA_DATA_CORRUPT',
          `User "${userId}" has no authzVersion. Run the Better Auth migrations for the Axeda plugin.`,
        );
      }
      return row.authzVersion;
    },

    async getPolicyVersion() {
      const row = await adapter.findOne<StateRow>({ model: MODELS.state, where: policyWhere });
      return row?.version ?? 0;
    },

    async bumpPolicyVersion() {
      await ensurePolicyRow();
      const row = await adapter.incrementOne<StateRow>({
        model: MODELS.state,
        where: policyWhere,
        increment: { version: 1 },
      });
      if (!row) {
        throw new AxedaError('AXEDA_DATA_CORRUPT', 'The Axeda policy state row is missing.');
      }
      return row.version;
    },
  };
}

/**
 * Implementa los puertos de persistencia de Axeda sobre el adaptador de base de datos de
 * Better Auth (`ctx.adapter`). Sirve para cualquier base que Better Auth soporte; las
 * transacciones deben ser reales, algo que Axeda comprueba al arrancar (ADR-0009).
 */
export function createBetterAuthPersistence<Options extends BetterAuthOptions>(
  databaseAdapter: DBAdapter<Options>,
  options: BetterAuthPersistenceOptions = {},
): AxedaPersistence {
  // El adaptador se parametriza por las opciones de Better Auth de cada aplicación; aquí solo se
  // usan operaciones que no dependen de ellas.
  const adapter = databaseAdapter as unknown as DBAdapter;
  const now = options.now ?? (() => new Date());

  // La fila de la versión de política se crea la primera vez, FUERA de cualquier transacción:
  // una inserción duplicada dentro de una transacción de PostgreSQL la dejaría abortada.
  let ensured: Promise<void> | null = null;
  const ensurePolicyRow = (): Promise<void> => {
    ensured ??= (async () => {
      const where = [{ field: 'key', value: POLICY_STATE_KEY }];
      if (await adapter.findOne({ model: MODELS.state, where })) return;
      try {
        await adapter.create({ model: MODELS.state, data: { key: POLICY_STATE_KEY, version: 0 } });
      } catch (error) {
        // Otra instancia la creó a la vez: es lo que se buscaba.
        if (!isUniqueViolation(error)) throw error;
      }
    })().catch((error: unknown) => {
      ensured = null;
      throw error;
    });
    return ensured;
  };

  const storesFor = (
    target: Adapter,
    atomic: Atomic,
    ensure: () => Promise<void>,
  ): AxedaStores => ({
    roles: createRoleStore(target, atomic, now),
    assignments: createAssignmentStore(target, now),
    authz: createAuthzStore(target, ensure),
  });

  const root = storesFor(
    adapter,
    (work) => adapter.transaction((trx) => work(trx)),
    ensurePolicyRow,
  );

  return {
    ...root,
    async transaction<T>(callback: (stores: AxedaStores) => Promise<T>): Promise<T> {
      await ensurePolicyRow();
      return adapter.transaction((trx) =>
        callback(
          storesFor(
            trx,
            (work) => work(trx),
            () => Promise.resolve(),
          ),
        ),
      );
    },
  };
}
