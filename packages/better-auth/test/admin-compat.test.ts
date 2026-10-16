import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { admin } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { axeda } from '../src/index.js';
import { closeAfterTest } from './support/cleanup.js';

/**
 * Axeda añade al usuario los mismos campos de bloqueo que el plugin `admin` de Better Auth
 * (mismos nombres y tipos) para que una aplicación que ya lo usa no choque. Axeda NO usa los
 * roles de ese plugin (T8: dos sistemas de permisos); esto solo comprueba que el esquema convive.
 */
describe('coexistence with the Better Auth admin plugin schema', () => {
  it('builds and migrates a database that uses both plugins', async () => {
    const db = new Database(':memory:');
    closeAfterTest(() => void db.close());
    const config = {
      secret: 'test-secret-test-secret-test-secret-0123456789',
      baseURL: 'http://localhost:3000',
      database: db,
      emailAndPassword: { enabled: true },
      plugins: [admin(), axeda({ permissions: ['invoice:read'] })],
    };
    await (await getMigrations(config)).runMigrations();
    await betterAuth(config).$context;

    const columns = (db.prepare('PRAGMA table_info(user)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const column of ['banned', 'banReason', 'banExpires', 'authzVersion']) {
      expect(columns.filter((name) => name === column)).toHaveLength(1);
    }
  });
});
