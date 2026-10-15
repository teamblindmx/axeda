import { runPersistenceContract } from '@axeda/testing';
import { createBetterAuthPersistence } from '../src/index.js';
import { createAuth, createUsers, type DatabaseKind } from './support/harness.js';

const kinds: DatabaseKind[] = ['sqlite', 'postgres'];

for (const kind of kinds) {
  runPersistenceContract(`Better Auth on ${kind}`, async (users) => {
    const { adapter } = await createAuth(kind);
    await createUsers(adapter, users);
    return createBetterAuthPersistence(adapter);
  });
}
