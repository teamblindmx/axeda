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
