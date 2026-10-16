import type { ManagedUser } from '../domain/user.js';
import type { Page, PageRequest } from './paging.js';

/** Lo que Axeda necesita saber de un usuario de Better Auth. */
export interface DirectoryUser {
  readonly id: string;
  readonly email: string;
  /** Solo un correo verificado puede aceptar una invitación enviada a esa dirección. */
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly banned: boolean;
}

/** Puerto de identidad: Axeda no administra usuarios, solo los consulta. */
export interface UserDirectory {
  find(userId: string): Promise<DirectoryUser | null>;
  findByEmail(email: string): Promise<DirectoryUser | null>;
}

export interface UserFilter {
  /** Correos que empiezan por este texto (sin distinguir mayúsculas). */
  readonly emailPrefix?: string | undefined;
  readonly banned?: boolean | undefined;
}

export interface NewUser {
  readonly email: string;
  readonly name: string;
}

export interface BanDetails {
  readonly reason: string | null;
  readonly expiresAt: Date | null;
}

/**
 * Administración de usuarios sobre el sistema de identidad (Better Auth). Axeda **no maneja
 * contraseñas**: crea la cuenta sin credencial y la persona la establece por el flujo normal
 * (restablecer contraseña, acceso social o aceptar una invitación).
 *
 * Estas operaciones corren fuera de las transacciones de Axeda: escriben en las tablas de
 * Better Auth y respetan sus ganchos.
 */
export interface UserAdmin {
  get(userId: string): Promise<ManagedUser | null>;
  list(filter: UserFilter, page: PageRequest): Promise<Page<ManagedUser>>;
  /** Lanza `AXEDA_EMAIL_TAKEN` si el correo ya tiene cuenta. */
  create(input: NewUser): Promise<ManagedUser>;
  /** `null` desbloquea. Devuelve el usuario ya actualizado. */
  setBan(userId: string, ban: BanDetails | null): Promise<ManagedUser>;
  /** Cierra todas sus sesiones. Devuelve cuántas había. */
  revokeSessions(userId: string): Promise<number>;
}
