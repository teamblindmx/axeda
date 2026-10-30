import { AxedaError, isBanned, type Principal } from '@teamblind/axeda-core';

type UserRow = { readonly id: string } & Record<string, unknown>;

const asDate = (value: unknown): Date | null =>
  value instanceof Date || typeof value === 'string' || typeof value === 'number'
    ? new Date(value)
    : null;

/**
 * Quien es el usuario para Axeda, a partir de la fila de usuario que Better Auth acaba de leer
 * de la base de datos (nunca de lo que envíe el cliente). Se usa en todos los caminos que
 * llegan con una sesión: los endpoints del plugin y las rutas de tu aplicación.
 *
 * - `authzVersion` ahorra consultas (la caché de Axeda se valida con ella).
 * - `twoFactorEnabled` permite evaluar las funciones que exigen 2FA.
 * - `banned` hace que un usuario bloqueado no pueda nada, incluso si llega por una vía que
 *   no pasó por el control de inicio de sesión (p. ej. una llave de API).
 */
export function principalFromUser(user: UserRow) {
  const principal: Principal = {
    userId: user.id,
    authzVersion: typeof user['authzVersion'] === 'number' ? user['authzVersion'] : undefined,
    twoFactorEnabled: user['twoFactorEnabled'] === true,
    banned: isBanned(
      { banned: user['banned'] === true, banExpires: asDate(user['banExpires']) },
      new Date(),
    ),
  };
  return principal;
}

/** Lo que se necesita de Better Auth para releer la fila de un usuario (su `internalAdapter`). */
export interface UserLookup {
  findUserById(userId: string): Promise<{ readonly id: string } | null>;
}

/**
 * La fila de usuario con la que decidir. Sin `secondaryStorage`, Better Auth la acaba de leer de la
 * base de datos junto con la sesión. Con `secondaryStorage` (p. ej. Redis), la sesión trae una copia
 * que Better Auth solo refresca cuando él mismo cambia al usuario: no se entera de que Axeda subió
 * `authzVersion`, y la caché seguiría concediendo lo revocado. Entonces se relee de la base de datos.
 * `null` si el usuario ya no existe.
 */
export async function currentUserRow(
  user: UserRow,
  /** Las opciones de Better Auth. */
  options: object | undefined,
  lookup: () => Promise<UserLookup | undefined> | UserLookup | undefined,
): Promise<UserRow | null> {
  const { secondaryStorage } = (options ?? {}) as { readonly secondaryStorage?: unknown };
  if (secondaryStorage === undefined || secondaryStorage === null) return user;
  const users = await lookup();
  if (users === undefined) {
    throw new AxedaError(
      'AXEDA_INVALID_CONFIG',
      'Sessions come from secondaryStorage, so Axeda must re-read the user from the database, ' +
        'but no internalAdapter was given to read it with.',
    );
  }
  return (await users.findUserById(user.id)) as UserRow | null;
}

/** Lo mínimo que se necesita de `auth` (así no se ata a la forma exacta de Better Auth). */
export interface SessionReader {
  readonly api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string } & Record<string, unknown> } | null>;
  };
  /** Las opciones de Better Auth: si hay `secondaryStorage`, el usuario se relee de la base de datos. */
  readonly options?: object | undefined;
  readonly $context?: Promise<{ readonly internalAdapter: UserLookup }> | undefined;
}

/**
 * Cómo saber quién hace una petición de tu aplicación: pregunta a Better Auth por la sesión
 * (cookie o, si usas ese plugin, llave de API) y la convierte en un `Principal`. Sin sesión da
 * `null`. Se le pasa a `createAxedaExpress({ principal })`.
 *
 * ```ts
 * createAxedaExpress({ axeda: axedaPlugin.instance(), principal: sessionPrincipal(auth) });
 * ```
 */
export function sessionPrincipal(
  auth: SessionReader,
): (request: { readonly headers: Headers }) => Promise<Principal | null> {
  return async ({ headers }) => {
    const session = await auth.api.getSession({ headers });
    if (session === null) return null;
    const user = await currentUserRow(
      session.user,
      auth.options,
      async () => (await auth.$context)?.internalAdapter,
    );
    return user === null ? null : principalFromUser(user);
  };
}
