import { AsyncLocalStorage } from 'node:async_hooks';
import { createMemoryPersistence, createMemoryUserDirectory } from '@teamblind/axeda-testing';
import {
  GLOBAL_SCOPE,
  createAxeda,
  type Actor,
  type AssignmentScope,
  type Axeda,
  type AxedaOptions,
  type AxedaPersistence,
  type Business,
  type Clock,
  type Company,
  type InvitationDelivery,
  type InvitationMessage,
  type Role,
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
  readonly persistence: AxedaPersistence;
  readonly users: ReturnType<typeof createMemoryUserDirectory>;
  readonly clock: { current: Date };
  /** Administrador global (función `*`), creado con `bootstrap`. */
  readonly admin: Actor;
  /** Correos "enviados" por las invitaciones. */
  readonly sent: InvitationMessage[];
  /** Mientras `on` sea `true`, el envío de invitaciones falla. */
  readonly failDelivery: { on: boolean };
  /** Atajo: crea un usuario y devuelve su actor. */
  user(id: string, extra?: { twoFactorEnabled?: boolean; emailVerified?: boolean }): Actor;
  /** Crea una función como administrador y la devuelve. */
  role(key: string, permissions: string[], extra?: { requireMfa?: boolean }): Promise<Role>;
  /** Asigna una función como administrador. */
  give(userId: string, roleKey: string, scope?: AssignmentScope): Promise<void>;
  /** Crea una compañía con ESE identificador (el `slug` es el identificador en minúsculas). */
  company(id: string): Promise<Company>;
  /** Crea un negocio con ESE identificador dentro de la compañía indicada. */
  business(id: string, companyId: string): Promise<Business>;
}

/**
 * Guarda: dentro de una transacción solo pueden usarse los almacenes de ESA transacción. Usar los
 * almacenes raíz, el directorio de usuarios o cualquier otra consulta externa es, en una base de
 * una sola conexión (SQLite), un bloqueo mortal: la transacción tiene la conexión y la consulta
 * esperaría por siempre. La memoria no lo sufre de la misma forma, así que se simula aquí.
 * Se sigue el contexto asíncrono, de modo que dos peticiones concurrentes no se confunden.
 */
function guardAgainstQueriesInsideTransactions(persistence: AxedaPersistence): {
  outside: <A extends unknown[], R>(
    name: string,
    fn: (...args: A) => Promise<R>,
  ) => (...args: A) => Promise<R>;
} {
  const inTransaction = new AsyncLocalStorage<true>();
  const outside =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (inTransaction.getStore() === true) {
        throw new Error(`${name} was called inside a transaction (it would deadlock on SQLite)`);
      }
      return fn(...args);
    };

  const realTransaction = persistence.transaction.bind(persistence);
  persistence.transaction = (callback) =>
    realTransaction((stores) => inTransaction.run(true, () => callback(stores)));

  const wrap = <T extends object>(store: T, label: string): void => {
    for (const key of Object.keys(store) as Array<keyof T>) {
      const method = store[key];
      if (typeof method === 'function') {
        store[key] = outside(`${label}.${String(key)}`, method.bind(store) as never) as T[keyof T];
      }
    }
  };
  for (const label of [
    'roles',
    'assignments',
    'authz',
    'audit',
    'companies',
    'businesses',
    'invitations',
  ] as const) {
    wrap(persistence[label], label);
  }
  return { outside };
}

export async function createFixture(
  options: AxedaOptions = BASE_OPTIONS,
  extra: { invitations?: boolean } = {},
): Promise<Fixture> {
  const forcedIds: string[] = [];
  const persistence = createMemoryPersistence({
    nextId: () => forcedIds.shift() ?? globalThis.crypto.randomUUID(),
  });
  const clock = { current: new Date('2026-06-01T12:00:00.000Z') };
  const directory = createMemoryUserDirectory([], { now: () => clock.current });
  const fakeClock: Clock = { now: () => clock.current };
  const sent: InvitationMessage[] = [];
  const failDelivery = { on: false };
  const delivery: InvitationDelivery = {
    send: async (message) => {
      if (failDelivery.on) throw new Error('smtp is down');
      sent.push(message);
    },
  };

  const { outside } = guardAgainstQueriesInsideTransactions(persistence);
  const users = {
    ...directory,
    find: outside('UserDirectory.find', directory.find),
    findByEmail: outside('UserDirectory.findByEmail', directory.findByEmail),
    get: outside('UserAdmin.get', directory.get),
    list: outside('UserAdmin.list', directory.list),
    create: outside('UserAdmin.create', directory.create),
    setBan: outside('UserAdmin.setBan', directory.setBan),
    revokeSessions: outside('UserAdmin.revokeSessions', directory.revokeSessions),
  };
  const axeda = createAxeda(options, {
    persistence,
    users,
    userAdmin: users,
    clock: fakeClock,
    ...(extra.invitations === false ? {} : { invitations: delivery }),
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
    sent,
    failDelivery,
    user(id, more = {}) {
      directory.add({ id, ...more });
      return {
        userId: id,
        ...(more.twoFactorEnabled === undefined ? {} : { twoFactorEnabled: more.twoFactorEnabled }),
      };
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
    async company(id) {
      forcedIds.push(id);
      return axeda.companies.create(admin, { slug: id.toLowerCase(), name: `Company ${id}` });
    },
    async business(id, companyId) {
      forcedIds.push(id);
      return axeda.businesses.create(admin, companyId, {
        slug: id.toLowerCase(),
        name: `Business ${id}`,
      });
    },
  };
}
