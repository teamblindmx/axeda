import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { describe, expect, it } from 'vitest';
import { axeda } from '../src/index.js';
import { axedaSchema as published } from './fixtures/schema-0.1.0-alpha.0.js';
import { databaseKinds, migrate, openDatabase } from './support/databases.js';

const role = (key: string) => ({
  key,
  name: key,
  permissions: [],
  requireMfa: false,
  status: 'active',
  managed: false,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/**
 * Las restricciones únicas pasaron de `unique` de un campo a índices únicos de tabla (para que
 * MongoDB las cree). Una base creada con la versión publicada debe aceptar la migración nueva, no
 * perder filas y seguir rechazando duplicados.
 */
describe.each(databaseKinds.filter((kind) => kind !== 'mongo-server'))(
  'upgrading a database created by 0.1.0-alpha.0 (%s)',
  (kind) => {
    it('keeps its rows, accepts the migration twice and still refuses duplicates', async () => {
      const { database, options } = await openDatabase(kind);
      const base = {
        secret: 'test-secret-test-secret-test-secret-0123456789',
        baseURL: 'http://localhost:3000',
        database,
        emailAndPassword: { enabled: true },
        ...options,
      } satisfies BetterAuthOptions;

      const before = { ...base, plugins: [{ ...axeda({ permissions: [] }), schema: published }] };
      await migrate(kind, before);
      const old = await betterAuth(before).$context;
      await old.adapter.create({ model: 'axedaRole', data: role('old') });

      const after = { ...base, plugins: [axeda({ permissions: [] })] };
      await migrate(kind, after);
      await migrate(kind, after);
      const now = (await betterAuth(after).$context).adapter;

      expect(await now.count({ model: 'axedaRole' })).toBe(1);
      await expect(now.create({ model: 'axedaRole', data: role('old') })).rejects.toBeDefined();
    });
  },
);
