import type { DBAdapter } from '@better-auth/core/db/adapter';
import { describe, expect, it } from 'vitest';
import { createBetterAuthPersistence } from '../src/index.js';

/** Un adaptador que solo sabe lo que necesita la persistencia antes de abrir una transacción. */
function fakeAdapter(id: string, failure: Error): DBAdapter {
  return {
    id,
    findOne: async () => ({ id: 'policy' }),
    updateMany: async () => 0,
    transaction: async () => {
      throw failure;
    },
  } as unknown as DBAdapter;
}

describe('transactions on MongoDB without a replica set', () => {
  const serverError = new Error(
    'Transaction numbers are only allowed on a replica set member or mongos',
  );

  it('says what to do instead of passing the server error through', async () => {
    const persistence = createBetterAuthPersistence(fakeAdapter('mongodb-adapter', serverError));
    const failure = await persistence.transaction(async () => 1).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'AXEDA_TRANSACTIONS_UNSUPPORTED', cause: serverError });
    expect((failure as Error).message).toContain('replica set');
  });

  it('lets every other error through untouched', async () => {
    const other = new Error('boom');
    const persistence = createBetterAuthPersistence(fakeAdapter('mongodb-adapter', other));
    await expect(persistence.transaction(async () => 1)).rejects.toBe(other);
  });
});
