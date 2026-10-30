import type { AuthContext } from '@better-auth/core';
import {
  AxedaError,
  isBanned,
  type BanDetails,
  type ManagedUser,
  type NewUser,
  type Page,
  type PageRequest,
  type UserAdmin,
  type UserFilter,
} from '@teamblind/axeda-core';
import { isUniqueViolation } from './errors.js';
import { byId, decodeCursor, encodeCursor } from './shared.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean | null;
  twoFactorEnabled?: boolean | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | string | null;
  createdAt: Date | string;
}

const asDate = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

/**
 * El usuario como lo ve la administración. Nunca se copia el resto de la fila: así una columna
 * nueva (o un secreto que una aplicación añada al usuario) no sale por la API (S17).
 */
export function toManagedUser(row: UserRow, now: Date): ManagedUser {
  const banExpires = asDate(row.banExpires);
  const flag = row.banned === true;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.emailVerified === true,
    twoFactorEnabled: row.twoFactorEnabled === true,
    // El bloqueo se calcula con la hora actual: uno con fecha de fin se levanta solo.
    banned: isBanned({ banned: flag, banExpires }, now),
    banReason: flag ? (row.banReason ?? null) : null,
    banExpires: flag ? banExpires : null,
    createdAt: asDate(row.createdAt) ?? new Date(0),
  };
}

export interface BetterAuthUserAdminOptions {
  readonly now?: () => Date;
}

/**
 * Administración de usuarios sobre Better Auth. Crea y modifica usuarios con su `internalAdapter`
 * (así se ejecutan los ganchos de la aplicación) y **no maneja contraseñas**: la cuenta nace sin
 * credencial y la persona la establece por el flujo normal.
 */
export function createBetterAuthUserAdmin(
  context: Pick<AuthContext, 'adapter' | 'internalAdapter'>,
  options: BetterAuthUserAdminOptions = {},
): UserAdmin {
  const now = options.now ?? (() => new Date());
  const { adapter, internalAdapter } = context;

  const need = async (userId: string): Promise<UserRow> => {
    const row = await adapter.findOne<UserRow>({ model: 'user', where: byId(userId) });
    if (row === null) {
      throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${userId}" does not exist.`);
    }
    return row;
  };

  return {
    async get(userId) {
      const row = await adapter.findOne<UserRow>({ model: 'user', where: byId(userId) });
      return row === null ? null : toManagedUser(row, now());
    },

    async list(filter: UserFilter, page: PageRequest): Promise<Page<ManagedUser>> {
      const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
      const rows = await adapter.findMany<UserRow>({
        model: 'user',
        where: [
          ...(filter.emailPrefix === undefined
            ? []
            : [
                {
                  field: 'email',
                  operator: 'starts_with' as const,
                  value: filter.emailPrefix.toLowerCase(),
                },
              ]),
          ...(after === null ? [] : [{ field: 'id', operator: 'gt' as const, value: after }]),
        ],
        sortBy: { field: 'id', direction: 'asc' },
        limit: page.limit + 1,
      });
      const at = now();
      const kept = rows.slice(0, page.limit);
      const last = kept.at(-1);
      // El filtro de bloqueo se aplica con la hora actual (un bloqueo vencido ya no cuenta), por
      // eso no puede ir en la consulta; una página puede salir con menos elementos que el límite.
      const items = kept
        .map((row) => toManagedUser(row, at))
        .filter((user) => filter.banned === undefined || user.banned === filter.banned);
      return { items, nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null };
    },

    async create(input: NewUser) {
      const taken = () => new AxedaError('AXEDA_EMAIL_TAKEN', 'That email already has an account.');
      if (await internalAdapter.findUserByEmail(input.email)) throw taken();
      try {
        // `method: 'admin'`: Better Auth lo marca como alta hecha por un administrador.
        const created = await internalAdapter.createUser(
          { email: input.email, name: input.name, emailVerified: false },
          { method: 'admin' },
        );
        return toManagedUser(await need(created.id), now());
      } catch (error) {
        if (isUniqueViolation(error)) throw taken();
        throw error;
      }
    },

    async setBan(userId, ban: BanDetails | null) {
      await need(userId);
      await internalAdapter.updateUser(userId, {
        banned: ban !== null,
        banReason: ban?.reason ?? null,
        banExpires: ban?.expiresAt ?? null,
      });
      return toManagedUser(await need(userId), now());
    },

    async revokeSessions(userId) {
      await need(userId);
      const open = (await internalAdapter.listSessions(userId)).length;
      await internalAdapter.deleteUserSessions(userId);
      return open;
    },
  };
}
