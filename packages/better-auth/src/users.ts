import type { BetterAuthOptions } from '@better-auth/core';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { isBanned, type DirectoryUser, type UserDirectory } from '@axeda/core';

interface UserRow {
  id: string;
  email: string;
  emailVerified?: boolean | null;
  // Solo existen si la aplicación activa los plugins de Better Auth que los añaden.
  twoFactorEnabled?: boolean | null;
  banned?: boolean | null;
  banExpires?: Date | string | null;
}

const toDirectoryUser = (row: UserRow, now: Date): DirectoryUser => ({
  id: row.id,
  email: row.email,
  emailVerified: row.emailVerified === true,
  // Ante la duda, sin 2FA: las funciones que lo exigen no se asignan ni conceden.
  twoFactorEnabled: row.twoFactorEnabled === true,
  // Un bloqueo con fecha de fin deja de valer al llegar esa fecha.
  banned: isBanned(
    { banned: row.banned === true, banExpires: row.banExpires ? new Date(row.banExpires) : null },
    now,
  ),
});

/**
 * Directorio de usuarios sobre la tabla `user` de Better Auth. Axeda no crea ni modifica
 * usuarios: solo los consulta.
 */
export function createBetterAuthUserDirectory<Options extends BetterAuthOptions>(
  databaseAdapter: DBAdapter<Options>,
  options: { readonly now?: () => Date } = {},
): UserDirectory {
  const now = options.now ?? (() => new Date());
  const adapter = databaseAdapter as unknown as DBAdapter;
  const find = async (field: 'id' | 'email', value: string): Promise<DirectoryUser | null> => {
    const row = await adapter.findOne<UserRow>({ model: 'user', where: [{ field, value }] });
    return row === null ? null : toDirectoryUser(row, now());
  };

  return {
    find: (userId) => find('id', userId),
    // Better Auth guarda los correos en minúsculas.
    findByEmail: (email) => find('email', email.trim().toLowerCase()),
  };
}
