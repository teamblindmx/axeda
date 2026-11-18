import type { AssignmentScope } from './scope.js';

/**
 * Un número de teléfono en formato E.164: `+`, el código de país (sin cero inicial) y el resto, sin
 * espacios ni guiones; de 8 a 15 dígitos en total.
 */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Por dónde llega la invitación: a un correo o a un número de teléfono. */
export type InvitationChannel = 'email' | 'phone';

/** Una invitación para recibir funciones en un alcance. Nunca contiene el secreto. */
export interface Invitation {
  readonly id: string;
  readonly channel: InvitationChannel;
  /** En minúsculas. Vacío en una invitación por teléfono. */
  readonly email: string;
  /** En formato E.164 (`+5215512345678`). `null` en una invitación por correo. */
  readonly phoneNumber: string | null;
  readonly scope: AssignmentScope;
  readonly roleIds: readonly string[];
  readonly invitedBy: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Lo que guarda el almacén: la invitación más el hash del secreto. */
export interface StoredInvitation extends Invitation {
  readonly secretHash: string;
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

/**
 * El contacto al que va la invitación: el correo o el número. Un correo lleva `@` y un número E.164
 * empieza por `+`, así que nunca coinciden: sirve de clave de «una pendiente por contacto».
 */
export const invitationContact = (invitation: {
  readonly channel: InvitationChannel;
  readonly email: string;
  readonly phoneNumber: string | null;
}): string => (invitation.channel === 'phone' ? (invitation.phoneNumber ?? '') : invitation.email);

export function invitationState(invitation: Invitation, now: Date): InvitationState {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  return invitation.expiresAt <= now ? 'expired' : 'pending';
}

/** La invitación sin el hash del secreto, con los campos enumerados a propósito (S17). */
export const withoutSecret = (invitation: StoredInvitation): Invitation => ({
  id: invitation.id,
  channel: invitation.channel,
  email: invitation.email,
  phoneNumber: invitation.phoneNumber,
  scope: invitation.scope,
  roleIds: invitation.roleIds,
  invitedBy: invitation.invitedBy,
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  acceptedAt: invitation.acceptedAt,
  revokedAt: invitation.revokedAt,
});
