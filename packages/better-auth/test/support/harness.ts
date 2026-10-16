import { PGlite } from '@electric-sql/pglite';
import type { AuthContext, BetterAuthOptions } from '@better-auth/core';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { betterAuth, type Auth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { axeda } from '../../src/index.js';
import { closeAfterTest } from './cleanup.js';
import { createPgliteDialect } from './pglite-dialect.js';

export type DatabaseKind = 'sqlite' | 'postgres';

export interface TestAuth {
  readonly auth: Auth<BetterAuthOptions>;
  readonly context: AuthContext;
  readonly adapter: DBAdapter;
}

/** Un Better Auth real con el plugin de Axeda, migrado, sobre una base de datos nueva. */
export async function createAuth(kind: DatabaseKind): Promise<TestAuth> {
  const sqlite = kind === 'sqlite' ? new Database(':memory:') : undefined;
  const pglite = kind === 'postgres' ? new PGlite() : undefined;
  if (sqlite) closeAfterTest(() => void sqlite.close());
  if (pglite) closeAfterTest(() => pglite.close());
  const database =
    sqlite ??
    ({
      dialect: createPgliteDialect(pglite as PGlite),
      type: 'postgres' as const,
      transaction: true,
    } as const);

  const options: BetterAuthOptions = {
    secret: 'test-secret-test-secret-test-secret-0123456789',
    baseURL: 'http://localhost:3000',
    database,
    emailAndPassword: { enabled: true },
    plugins: [axeda({ permissions: [] })],
  };
  const { runMigrations } = await getMigrations(options);
  await runMigrations();

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
