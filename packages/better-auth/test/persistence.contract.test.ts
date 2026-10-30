import { runPersistenceContract } from '@teamblind/axeda-testing';
import { createBetterAuthPersistence } from '../src/index.js';
import { databaseKinds } from './support/databases.js';
import { createAuth, createUsers } from './support/harness.js';

for (const kind of databaseKinds) {
  runPersistenceContract(`Better Auth on ${kind}`, async (users) => {
    const { adapter } = await createAuth(kind);
    await createUsers(adapter, users);
    return createBetterAuthPersistence(adapter);
  });
}
