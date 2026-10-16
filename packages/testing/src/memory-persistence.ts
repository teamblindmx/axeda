import {
  AxedaError,
  createAuditIdFactory,
  scopeKey,
  type AssignmentStore,
  type AuditEvent,
  type AuditFilter,
  type AuditStore,
  type AuthzStateStore,
  type AxedaPersistence,
  type AxedaStores,
  type NewAssignment,
  type NewAuditEvent,
  type NewRole,
  type Page,
  type PageRequest,
  type Role,
  type RoleAssignment,
  type RoleChanges,
  type RoleStore,
} from '@axeda/core';
import {
  decodeCursor,
  encodeCursor,
  createBusinessStore,
  createCompanyStore,
  createInvitationStore,
  type Run,
  type TenantState,
} from './memory-tenants.js';

export interface MemoryPersistenceOptions {
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

interface State extends TenantState {
  roles: Map<string, Role>;
  audit: AuditEvent[];
  assignments: Map<string, RoleAssignment>;
  userVersions: Map<string, number>;
  policyVersion: number;
}

const snapshot = (state: State): State => ({
  companies: new Map(state.companies),
  businesses: new Map(state.businesses),
  invitations: new Map(state.invitations),
  roles: new Map(state.roles),
  audit: [...state.audit],
  assignments: new Map(state.assignments),
  userVersions: new Map(state.userVersions),
  policyVersion: state.policyVersion,
});

function restore(state: State, saved: State): void {
  state.companies = saved.companies;
  state.businesses = saved.businesses;
  state.invitations = saved.invitations;
  state.roles = saved.roles;
  state.audit = saved.audit;
  state.assignments = saved.assignments;
  state.userVersions = saved.userVersions;
  state.policyVersion = saved.policyVersion;
}

function createRoleStore(state: State, run: Run, now: () => Date, nextId: () => string): RoleStore {
  return {
    get: (id) => run(async () => state.roles.get(id) ?? null),
    getMany: (ids) => run(async () => ids.flatMap((id) => state.roles.get(id) ?? [])),
    getByKey: (key) =>
      run(async () => [...state.roles.values()].find((role) => role.key === key) ?? null),
    list: (page: PageRequest): Promise<Page<Role>> =>
      run(async () => {
        const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
        const sorted = [...state.roles.values()].sort((a, b) => a.key.localeCompare(b.key));
        const remaining = after === null ? sorted : sorted.filter((role) => role.key > after);
        const items = remaining.slice(0, page.limit);
        const last = items.at(-1);
        const hasMore = remaining.length > items.length;
        return { items, nextCursor: hasMore && last ? encodeCursor(last.key) : null };
      }),
    create: (input: NewRole) =>
      run(async () => {
        if ([...state.roles.values()].some((role) => role.key === input.key)) {
          throw new AxedaError(
            'AXEDA_ROLE_KEY_TAKEN',
            `A role with key "${input.key}" already exists.`,
          );
        }
        const at = now();
        const role: Role = {
          id: nextId(),
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
        };
        state.roles.set(role.id, role);
        return role;
      }),
    update: (id: string, expectedVersion: number, changes: RoleChanges) =>
      run(async () => {
        const current = state.roles.get(id);
        if (!current) throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${id}" does not exist.`);
        if (current.version !== expectedVersion) {
          throw new AxedaError(
            'AXEDA_VERSION_CONFLICT',
            `Role "${id}" is at version ${current.version}, not ${expectedVersion}.`,
          );
        }
        const updated: Role = {
          ...current,
          name: changes.name ?? current.name,
          description:
            changes.description === undefined ? current.description : changes.description,
          permissions: changes.permissions ? [...changes.permissions] : current.permissions,
          requireMfa: changes.requireMfa ?? current.requireMfa,
          status: changes.status ?? current.status,
          version: current.version + 1,
          updatedAt: now(),
        };
        state.roles.set(id, updated);
        return updated;
      }),
    delete: (id: string) =>
      run(async () => {
        if (!state.roles.delete(id)) return false;
        for (const [assignmentId, assignment] of state.assignments) {
          if (assignment.roleId === id) state.assignments.delete(assignmentId);
        }
        return true;
      }),
  };
}

function createAssignmentStore(
  state: State,
  run: Run,
  now: () => Date,
  nextId: () => string,
): AssignmentStore {
  const forUser = (userId: string): RoleAssignment[] =>
    [...state.assignments.values()].filter((assignment) => assignment.userId === userId);

  return {
    get: (id) => run(async () => state.assignments.get(id) ?? null),
    listForScope: (scope, page: PageRequest): Promise<Page<RoleAssignment>> =>
      run(async () => {
        const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
        const sorted = [...state.assignments.values()]
          .filter((assignment) => scopeKey(assignment.scope) === scopeKey(scope))
          .sort((a, b) => a.id.localeCompare(b.id));
        const remaining = after === null ? sorted : sorted.filter((item) => item.id > after);
        const items = remaining.slice(0, page.limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor: remaining.length > items.length && last ? encodeCursor(last.id) : null,
        };
      }),
    listForUser: (userId) =>
      run(async () =>
        forUser(userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    countForUser: (userId) => run(async () => forUser(userId).length),
    create: (input: NewAssignment) =>
      run(async () => {
        if (!state.roles.has(input.roleId)) {
          throw new AxedaError('AXEDA_ROLE_NOT_FOUND', `Role "${input.roleId}" does not exist.`);
        }
        const duplicate = forUser(input.userId).some(
          (existing) =>
            existing.roleId === input.roleId && scopeKey(existing.scope) === scopeKey(input.scope),
        );
        if (duplicate) {
          throw new AxedaError(
            'AXEDA_ASSIGNMENT_EXISTS',
            'The user already has that role in that scope.',
          );
        }
        const assignment: RoleAssignment = {
          id: nextId(),
          userId: input.userId,
          roleId: input.roleId,
          scope: input.scope,
          grantedBy: input.grantedBy ?? null,
          createdAt: now(),
          expiresAt: input.expiresAt ?? null,
        };
        state.assignments.set(assignment.id, assignment);
        return assignment;
      }),
    revoke: (id) => run(async () => state.assignments.delete(id)),
    deleteForUser: (userId) =>
      run(async () => {
        const mine = forUser(userId);
        for (const assignment of mine) state.assignments.delete(assignment.id);
        return mine.length;
      }),
  };
}

function createAuthzStore(state: State, run: Run): AuthzStateStore {
  return {
    getUserVersion: (userId) => run(async () => state.userVersions.get(userId) ?? 0),
    bumpUserVersion: (userId) =>
      run(async () => {
        const next = (state.userVersions.get(userId) ?? 0) + 1;
        state.userVersions.set(userId, next);
        return next;
      }),
    getPolicyVersion: () => run(async () => state.policyVersion),
    bumpPolicyVersion: () => run(async () => ++state.policyVersion),
  };
}

const matchesFilter = (event: AuditEvent, filter: AuditFilter): boolean => {
  const same = (wanted: string | undefined, actual: string | null): boolean =>
    wanted === undefined || actual === wanted;
  const sameScope =
    filter.scope === undefined ||
    (event.scope !== null && scopeKey(event.scope) === scopeKey(filter.scope));
  return (
    same(filter.actorId, event.actorId) &&
    same(filter.action, event.action) &&
    same(filter.targetType, event.targetType) &&
    same(filter.targetId, event.targetId) &&
    sameScope
  );
};

function createAuditStore(state: State, run: Run, now: () => Date): AuditStore {
  const nextAuditId = createAuditIdFactory();
  return {
    append: (input: NewAuditEvent) =>
      run(async () => {
        const at = now();
        const event: AuditEvent = { ...input, id: nextAuditId(at), at };
        state.audit.push(event);
        return event;
      }),
    list: (filter, page) =>
      run(async () => {
        const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
        const sorted = state.audit.filter((event) => matchesFilter(event, filter));
        sorted.sort((a, b) => b.id.localeCompare(a.id));
        const remaining = after === null ? sorted : sorted.filter((event) => event.id < after);
        const items = remaining.slice(0, page.limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor: remaining.length > items.length && last ? encodeCursor(last.id) : null,
        };
      }),
  };
}

/**
 * Persistencia en memoria con **transacciones reales**: si el callback lanza, el estado vuelve al
 * de antes. Las operaciones y transacciones se serializan. Es la implementación de referencia y
 * la que usan las pruebas; no es para producción.
 */
export function createMemoryPersistence(options: MemoryPersistenceOptions = {}): AxedaPersistence {
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? (() => globalThis.crypto.randomUUID());
  const state: State = {
    companies: new Map(),
    businesses: new Map(),
    invitations: new Map(),
    roles: new Map(),
    audit: [],
    assignments: new Map(),
    userVersions: new Map(),
    policyVersion: 0,
  };

  let tail: Promise<unknown> = Promise.resolve();
  const withLock: Run = (fn) => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => undefined);
    return result;
  };
  const inline: Run = (fn) => fn();

  const storesFor = (run: Run): AxedaStores => ({
    companies: createCompanyStore({ state, run, now, nextId }),
    businesses: createBusinessStore({ state, run, now, nextId }),
    invitations: createInvitationStore({ state, run, now, nextId }),
    roles: createRoleStore(state, run, now, nextId),
    assignments: createAssignmentStore(state, run, now, nextId),
    authz: createAuthzStore(state, run),
    audit: createAuditStore(state, run, now),
  });

  const root = storesFor(withLock);
  const inTransaction = storesFor(inline);

  return {
    ...root,
    transaction: <T>(callback: (stores: AxedaStores) => Promise<T>): Promise<T> =>
      withLock(async () => {
        const saved = snapshot(state);
        try {
          return await callback(inTransaction);
        } catch (error) {
          restore(state, saved);
          throw error;
        }
      }),
  };
}
