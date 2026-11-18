/** Un usuario tal como lo ve la administración de Axeda. Nunca incluye credenciales. */
export interface ManagedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  /** El teléfono (E.164), si la aplicación usa el acceso por teléfono; si no, `null`. */
  readonly phoneNumber: string | null;
  readonly phoneNumberVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly banned: boolean;
  readonly banReason: string | null;
  /** Hasta cuándo dura el bloqueo; `null` si es indefinido. */
  readonly banExpires: Date | null;
  readonly createdAt: Date;
}

/**
 * ¿Está bloqueado ahora? Un bloqueo con fecha de fin deja de valer al llegar esa fecha, sin que
 * nadie tenga que quitarlo: se calcula siempre, nunca se guarda ya resuelto.
 */
export function isBanned(
  user: { readonly banned: boolean; readonly banExpires: Date | null },
  now: Date,
): boolean {
  return user.banned && (user.banExpires === null || user.banExpires > now);
}
