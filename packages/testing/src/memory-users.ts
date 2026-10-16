import {
  AxedaError,
  isBanned,
  type BanDetails,
  type DirectoryUser,
  type ManagedUser,
  type NewUser,
  type Page,
  type PageRequest,
  type UserAdmin,
  type UserDirectory,
  type UserFilter,
} from '@axeda/core';
import { decodeCursor, encodeCursor } from './memory-tenants.js';

interface StoredUser extends ManagedUser {
  sessions: number;
}

export type MemoryUserInput = Partial<Omit<ManagedUser, 'id'>> & { id: string };

export interface MemoryUserDirectory extends UserDirectory, UserAdmin {
  /** Añade o reemplaza un usuario. */
  add(user: MemoryUserInput): ManagedUser;
  remove(userId: string): void;
  /** Simula `count` sesiones abiertas del usuario. */
  addSessions(userId: string, count: number): void;
  sessionsOf(userId: string): number;
}

export interface MemoryUsersOptions {
  readonly now?: () => Date;
}

/** Directorio y administración de usuarios en memoria para las pruebas del núcleo. */
export function createMemoryUserDirectory(
  initial: readonly MemoryUserInput[] = [],
  options: MemoryUsersOptions = {},
): MemoryUserDirectory {
  const now = options.now ?? (() => new Date());
  const users = new Map<string, StoredUser>();

  const add: MemoryUserDirectory['add'] = (user) => {
    const full: StoredUser = {
      email: `${user.id}@test.dev`,
      name: user.id,
      emailVerified: true,
      twoFactorEnabled: false,
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: now(),
      sessions: 0,
      ...user,
    };
    users.set(full.id, full);
    return full;
  };
  for (const user of initial) add(user);

  /** El estado de bloqueo se calcula siempre con la hora actual. */
  const view = (user: StoredUser): ManagedUser => ({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    banned: isBanned(user, now()),
    banReason: user.banReason,
    banExpires: user.banExpires,
    createdAt: user.createdAt,
  });
  const need = (userId: string): StoredUser => {
    const user = users.get(userId);
    if (user === undefined) {
      throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${userId}" does not exist.`);
    }
    return user;
  };
  const toDirectory = (user: StoredUser): DirectoryUser => ({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    banned: isBanned(user, now()),
  });

  return {
    add,
    remove: (userId) => void users.delete(userId),
    addSessions: (userId, count) => void (need(userId).sessions += count),
    sessionsOf: (userId) => users.get(userId)?.sessions ?? 0,

    find: async (userId) => {
      const user = users.get(userId);
      return user === undefined ? null : toDirectory(user);
    },
    findByEmail: async (email) => {
      const user = [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
      return user === undefined ? null : toDirectory(user);
    },

    get: async (userId) => {
      const user = users.get(userId);
      return user === undefined ? null : view(user);
    },
    list: async (filter: UserFilter, page: PageRequest): Promise<Page<ManagedUser>> => {
      const prefix = filter.emailPrefix?.toLowerCase();
      const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
      const sorted = [...users.values()]
        .filter((u) => prefix === undefined || u.email.toLowerCase().startsWith(prefix))
        .filter((u) => filter.banned === undefined || isBanned(u, now()) === filter.banned)
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((u) => after === null || u.id > after);
      const items = sorted.slice(0, page.limit);
      const last = items.at(-1);
      return {
        items: items.map(view),
        nextCursor: sorted.length > items.length && last ? encodeCursor(last.id) : null,
      };
    },
    create: async (input: NewUser) => {
      const email = input.email.toLowerCase();
      if ([...users.values()].some((u) => u.email.toLowerCase() === email)) {
        throw new AxedaError('AXEDA_EMAIL_TAKEN', 'That email already has an account.');
      }
      return view(
        add({
          id: globalThis.crypto.randomUUID(),
          email,
          name: input.name,
          emailVerified: false,
        }) as StoredUser,
      );
    },
    setBan: async (userId, ban: BanDetails | null) => {
      const user = need(userId);
      Object.assign(user, {
        banned: ban !== null,
        banReason: ban?.reason ?? null,
        banExpires: ban?.expiresAt ?? null,
      });
      return view(user);
    },
    revokeSessions: async (userId) => {
      const user = need(userId);
      const closed = user.sessions;
      user.sessions = 0;
      return closed;
    },
  };
}
