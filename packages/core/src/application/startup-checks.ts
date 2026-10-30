import { AxedaError } from '../errors.js';
import type { AxedaPersistence } from '../ports/persistence.js';

class ProbeRollback extends Error {}

/**
 * Comprueba que `transaction` deshace de verdad.
 *
 * Better Auth acepta adaptadores sin transacciones y los sustituye por una función que solo
 * ejecuta el callback, sin deshacer nada. Por eso no nos fiamos de banderas: dentro de una
 * transacción se crea una función de prueba y se sube la versión de política; luego se falla a
 * propósito y se comprueba que no quedó nada.
 */
export async function isTransactional(persistence: AxedaPersistence): Promise<boolean> {
  const probeKey = `__axeda_tx_probe_${globalThis.crypto.randomUUID()}`;
  const versionBefore = await persistence.authz.getPolicyVersion();

  try {
    await persistence.transaction(async (tx) => {
      await tx.roles.create({ key: probeKey, name: 'probe', permissions: [], status: 'inactive' });
      await tx.authz.bumpPolicyVersion();
      throw new ProbeRollback();
    });
  } catch (error) {
    if (!(error instanceof ProbeRollback)) throw error;
  }

  const leftover = await persistence.roles.getByKey(probeKey);
  const versionAfter = await persistence.authz.getPolicyVersion();
  if (leftover !== null) await persistence.roles.delete(leftover.id);
  return leftover === null && versionAfter === versionBefore;
}

export async function assertTransactional(persistence: AxedaPersistence): Promise<void> {
  if (!(await isTransactional(persistence))) {
    throw new AxedaError(
      'AXEDA_TRANSACTIONS_UNSUPPORTED',
      'The persistence layer does not roll back transactions. Axeda needs atomic transactions to ' +
        'keep permission versions consistent, so it refuses to start. Use a database adapter with ' +
        'real transaction support (for a Kysely dialect, enable `transaction: true`).',
    );
  }
}
