import { createMemoryPersistence, createMemoryUserDirectory } from '@axeda/testing';
import {
  GLOBAL_SCOPE,
  createAxeda,
  type Actor,
  type AssignmentScope,
  type Axeda,
  type AxedaOptions,
  type Clock,
  type Role,
  type ScopeResolver,
} from '../src/index.js';

export const BASE_OPTIONS = {
  permissions: [
    'invoice:read',
    'invoice:create',
    'invoice:update',
    'invoice:delete',
    'report:read',
  ],
} as const satisfies AxedaOptions;

export interface Fixture {
  readonly axeda: Axeda;
  readonly persistence: ReturnType<typeof createMemoryPersistence>;
  readonly users: ReturnType<typeof createMemoryUserDirectory>;
  readonly clock: { current: Date };
  /** Administrador global (función `*`), creado con `bootstrap`. */
  readonly admin: Actor;
  /** Atajo: crea un usuario y devuelve su actor. */
  user(id: string, extra?: { twoFactorEnabled?: boolean }): Actor;
  /** Crea una función como administrador y la devuelve. */
  role(key: string, permissions: string[], extra?: { requireMfa?: boolean }): Promise<Role>;
  /** Asigna una función como administrador. */
  give(userId: string, roleKey: string, scope?: AssignmentScope): Promise<void>;
}

export async function createFixture(
  options: AxedaOptions = BASE_OPTIONS,
  extra: { scopes?: ScopeResolver } = {},
): Promise<Fixture> {
  const persistence = createMemoryPersistence();
  const directory = createMemoryUserDirectory();
  const clock = { current: new Date('2026-06-01T12:00:00.000Z') };
  const fakeClock: Clock = { now: () => clock.current };

  // Guarda: nada externo (usuarios, resolvedor de negocios) puede consultarse DENTRO de una
  // transacción. Con una base de una sola conexión (SQLite) eso es un bloqueo mortal; la memoria
  // no lo sufre, así que se simula aquí para que estas pruebas lo detecten igualmente.
  let openTransactions = 0;
  const realTransaction = persistence.transaction.bind(persistence);
  persistence.transaction = async (callback) => {
    openTransactions += 1;
    try {
      return await realTransaction(callback);
    } finally {
      openTransactions -= 1;
    }
  };
  const outside =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (openTransactions > 0) {
        throw new Error(`${name} was called inside a transaction (it would deadlock on SQLite)`);
      }
      return fn(...args);
    };
  const users = {
    ...directory,
    find: outside('UserDirectory.find', directory.find),
    findByEmail: outside('UserDirectory.findByEmail', directory.findByEmail),
  };
  const scopes = extra.scopes && {
    companyOfBusiness: outside('ScopeResolver.companyOfBusiness', extra.scopes.companyOfBusiness),
  };
  const axeda = createAxeda(options, {
    persistence,
    users,
    clock: fakeClock,
    ...(scopes === undefined ? {} : { scopes }),
  });

  directory.add({ id: 'admin' });
  await axeda.bootstrap({ userId: 'admin' });
  const admin: Actor = { userId: 'admin' };
  const roleIds = new Map<string, string>();

  return {
    axeda,
    persistence,
    users: directory,
    clock,
    admin,
    user(id, more = {}) {
      directory.add({ id, ...more });
      return { userId: id, ...more };
    },
    async role(key, permissions, more = {}) {
      const role = await axeda.roles.create(admin, { key, name: key, permissions, ...more });
      roleIds.set(key, role.id);
      return role;
    },
    async give(userId, roleKey, scope = GLOBAL_SCOPE) {
      const roleId = roleIds.get(roleKey);
      if (roleId === undefined) throw new Error(`unknown role ${roleKey}`);
      await axeda.assignments.assign(admin, { userId, roleId, scope });
    },
  };
}
