import { isBanned, type Principal } from '@axeda/core';

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
export function principalFromUser(user: { readonly id: string } & Record<string, unknown>) {
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

/** Lo mínimo que se necesita de `auth.api` (así no se ata a la forma exacta de Better Auth). */
export interface SessionReader {
  readonly api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string } & Record<string, unknown> } | null>;
  };
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
    return session === null ? null : principalFromUser(session.user);
  };
}
