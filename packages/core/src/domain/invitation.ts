import type { AssignmentScope } from './scope.js';

/** Una invitación para recibir funciones en un alcance. Nunca contiene el secreto. */
export interface Invitation {
  readonly id: string;
  /** En minúsculas. */
  readonly email: string;
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

export function invitationState(invitation: Invitation, now: Date): InvitationState {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  return invitation.expiresAt <= now ? 'expired' : 'pending';
}

/** La invitación sin el hash del secreto, con los campos enumerados a propósito (S17). */
export const withoutSecret = (invitation: StoredInvitation): Invitation => ({
  id: invitation.id,
  email: invitation.email,
  scope: invitation.scope,
  roleIds: invitation.roleIds,
  invitedBy: invitation.invitedBy,
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  acceptedAt: invitation.acceptedAt,
  revokedAt: invitation.revokedAt,
});
