import type { MenuAdjustment } from '../config/menu-overrides.js';

/** Un ajuste guardado: global (`companyId` `null`) o de una compañía. */
export interface StoredMenuAdjustment extends MenuAdjustment {
  readonly companyId: string | null;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface MenuAdjustmentChange extends MenuAdjustment {
  readonly companyId: string | null;
  readonly updatedBy: string;
}

export interface MenuAdjustmentStore {
  /** Los ajustes globales (`null`) o los de una compañía. */
  list(companyId: string | null): Promise<readonly StoredMenuAdjustment[]>;
  /** Crea o **sustituye** el ajuste de ese elemento en ese nivel (uno solo por nivel y elemento). */
  set(change: MenuAdjustmentChange): Promise<StoredMenuAdjustment>;
  /** Devuelve `false` si no había ajuste. */
  delete(companyId: string | null, itemKey: string): Promise<boolean>;
  /** Para purgar: los ajustes de esas compañías. */
  deleteForCompanies(companyIds: readonly string[]): Promise<number>;
}
