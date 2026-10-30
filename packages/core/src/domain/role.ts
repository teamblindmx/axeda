import type { PermissionKey } from './permission-key.js';
import type { AssignmentScope } from './scope.js';

export type RoleStatus = 'active' | 'inactive';

/** Una "función" en español: conjunto de permisos que se asigna a usuarios. Solo global. */
export interface Role {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly PermissionKey[];
  /** Exige que el usuario tenga el 2FA activado (se evalúa sobre el usuario). */
  readonly requireMfa: boolean;
  readonly status: RoleStatus;
  /** Declarada en el código: de solo lectura en la API. */
  readonly managed: boolean;
  /** Concurrencia optimista: cada actualización exige la versión que se leyó. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RoleAssignment {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly scope: AssignmentScope;
  readonly grantedBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * Quien pide una autorización. Better Auth lo convierte a partir de la sesión.
 *
 * Los campos opcionales ahorran consultas y **deben venir de la base de datos** (la fila del
 * usuario de la sesión), nunca del cliente.
 */
export interface Principal {
  readonly userId: string;
  /** `authzVersion` del usuario. Si falta, Axeda la consulta. */
  readonly authzVersion?: number | undefined;
  /**
   * El usuario tiene el 2FA activado. Si falta se asume `false`: las funciones con
   * `requireMfa` no conceden nada (ante la duda, se deniega).
   */
  readonly twoFactorEnabled?: boolean | undefined;
  /**
   * El usuario está bloqueado ahora. Un usuario bloqueado no puede nada, aunque llegue por una
   * vía que no crea sesión (p. ej. la llave de API de su cuenta).
   */
  readonly banned?: boolean | undefined;
}

/** Datos de la petición para la auditoría. */
export interface RequestMeta {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** Quien ejecuta una operación de administración. */
export interface Actor extends Principal, RequestMeta {}
