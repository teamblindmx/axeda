import type { DirectoryUser, UserDirectory } from '@axeda/core';

export interface MemoryUserDirectory extends UserDirectory {
  /** Añade o reemplaza un usuario. */
  add(user: Partial<DirectoryUser> & { id: string }): DirectoryUser;
  remove(userId: string): void;
}

/** Directorio de usuarios en memoria para las pruebas del núcleo. */
export function createMemoryUserDirectory(
  initial: ReadonlyArray<Partial<DirectoryUser> & { id: string }> = [],
): MemoryUserDirectory {
  const users = new Map<string, DirectoryUser>();
  const add: MemoryUserDirectory['add'] = (user) => {
    const full: DirectoryUser = {
      email: `${user.id}@test.dev`,
      twoFactorEnabled: false,
      banned: false,
      ...user,
    };
    users.set(full.id, full);
    return full;
  };
  for (const user of initial) add(user);

  return {
    add,
    remove: (userId) => void users.delete(userId),
    find: async (userId) => users.get(userId) ?? null,
    findByEmail: async (email) =>
      [...users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase()) ?? null,
  };
}
