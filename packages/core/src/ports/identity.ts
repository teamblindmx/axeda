/** Lo que Axeda necesita saber de un usuario de Better Auth. */
export interface DirectoryUser {
  readonly id: string;
  readonly email: string;
  readonly twoFactorEnabled: boolean;
  readonly banned: boolean;
}

/** Puerto de identidad: Axeda no administra usuarios, solo los consulta. */
export interface UserDirectory {
  find(userId: string): Promise<DirectoryUser | null>;
  findByEmail(email: string): Promise<DirectoryUser | null>;
}

/**
 * Resuelve el padre de un negocio desde la base de datos (T2): la compañía de un negocio nunca
 * se toma de lo que envíe el cliente. Las compañías y los negocios llegan en la fase 4; hasta
 * entonces, sin este puerto los alcances de negocio se rechazan.
 */
export interface ScopeResolver {
  /** `null` si el negocio no existe. */
  companyOfBusiness(businessId: string): Promise<string | null>;
}
