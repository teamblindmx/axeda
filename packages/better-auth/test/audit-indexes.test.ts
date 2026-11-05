import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { axeda } from '../src/index.js';
import { axedaSchema, MODELS } from '../src/schema.js';
import { closeAfterTest } from './support/cleanup.js';

/**
 * Cada filtro del listado de auditoría necesita un índice que lo empiece. Sin el de `action`, filtrar
 * por acción recorre toda la tabla (que solo crece): 51-74 ms con 200 000 eventos en PostgreSQL 16 y 18,
 * medido con EXPLAIN. Un presupuesto de latencia no lo atrapa de forma fiable (a 20 000 filas la
 * diferencia cabe en el margen del servidor), así que se comprueba el esquema.
 */
describe('the audit log indexes', () => {
  const leading = axedaSchema[MODELS.audit].indexes.map((index) => index.fields[0]);

  it.each(['actorId', 'action', 'targetType', 'scopeType'])(
    'declares an index that starts with %s',
    (field) => {
      expect(leading).toContain(field);
    },
  );

  it('creates them in the database when Better Auth migrates', async () => {
    const database = new Database(':memory:');
    closeAfterTest(() => void database.close());
    const config = {
      database,
      secret: 'k3Jx9Qp2Zr7Lm4Vb8Nc1Td6Wy5Hs0Ga3Fe9Uo2Ri7Pq',
      baseURL: 'https://auth.example.com',
      plugins: [axeda({ permissions: ['invoice:read'] })],
    };
    await (await getMigrations(config)).runMigrations();
    betterAuth(config);

    const created = database
      .prepare(`PRAGMA index_list("${MODELS.audit}")`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(created).toContain(`${MODELS.audit}_action_idx`);
  });
});
