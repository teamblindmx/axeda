import type { StaffAccount } from '../domain/staff.js';
import type { Services } from './services.js';

/**
 * Borra los usuarios del personal cuyas cuentas ya se borraron (al purgar su compañía, negocio o
 * sede). Un fallo no detiene la purga: sin su cuenta de personal el usuario no puede entrar.
 */
export async function deleteStaffUsers(
  services: Services,
  accounts: readonly StaffAccount[],
): Promise<void> {
  const remove = services.userAdmin?.delete?.bind(services.userAdmin);
  if (remove === undefined || accounts.length === 0) return;
  await Promise.all(accounts.map((account) => remove(account.userId).catch(() => undefined)));
}
