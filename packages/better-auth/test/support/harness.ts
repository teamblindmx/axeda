import type { AuthContext, BetterAuthOptions } from '@better-auth/core';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { betterAuth, type Auth } from 'better-auth';
import { axeda } from '../../src/index.js';
import { migrate, openDatabase, type DatabaseKind } from './databases.js';

export type { DatabaseKind } from './databases.js';

export interface TestAuth {
  readonly auth: Auth<BetterAuthOptions>;
  readonly context: AuthContext;
  readonly adapter: DBAdapter;
}

/** Un Better Auth real con el plugin de Axeda, migrado, sobre una base de datos nueva. */
export async function createAuth(kind: DatabaseKind): Promise<TestAuth> {
  const { database, options: databaseOptions } = await openDatabase(kind);

  const options: BetterAuthOptions = {
    secret: 'test-secret-test-secret-test-secret-0123456789',
    baseURL: 'http://localhost:3000',
    database,
    emailAndPassword: { enabled: true },
    plugins: [axeda({ permissions: [] })],
    ...databaseOptions,
  };
  await migrate(kind, options);

  const auth = betterAuth(options);
  const context = await auth.$context;
  return { auth, context, adapter: context.adapter };
}

/** Crea usuarios con los identificadores indicados (las asignaciones los referencian). */
export async function createUsers(adapter: DBAdapter, ids: readonly string[]): Promise<void> {
  const now = new Date();
  for (const id of ids) {
    await adapter.create({
      model: 'user',
      forceAllowId: true,
      data: {
        id,
        name: id,
        email: `${id}@test.dev`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}
