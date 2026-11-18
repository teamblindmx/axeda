/** El estado de una funcionalidad en una compañía, tal como lo dejó la plataforma. */
export interface CompanyFeature {
  readonly companyId: string;
  readonly feature: string;
  readonly enabled: boolean;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface FeatureChange {
  readonly companyId: string;
  readonly feature: string;
  readonly enabled: boolean;
  readonly updatedBy: string;
}

/**
 * Solo se guarda lo que la plataforma cambió; lo demás sale del valor por omisión de cada
 * funcionalidad (`enabledByDefault`).
 */
export interface FeatureStore {
  listForCompanies(companyIds: readonly string[]): Promise<readonly CompanyFeature[]>;
  /** Crea o cambia el estado (uno solo por compañía y funcionalidad). */
  set(change: FeatureChange): Promise<CompanyFeature>;
  /** Para purgar: borra el estado de esas compañías y dice cuántos había. */
  deleteForCompanies(companyIds: readonly string[]): Promise<number>;
}
