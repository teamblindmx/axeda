# Pruebas

`@teamblind/axeda-testing` te da el mismo Axeda, sin base de datos: almacenes en memoria que pasan la misma
suite de contrato que los reales.

```ts
import { createAxeda } from '@teamblind/axeda-core';
import { createMemoryPersistence, createMemoryUserDirectory } from '@teamblind/axeda-testing';

const users = createMemoryUserDirectory([]);
const axeda = createAxeda(
  { permissions: ['invoice:read'], roles: { viewer: ['invoice:read'] } },
  { persistence: createMemoryPersistence(), users, userAdmin: users },
);

users.add({ id: 'root' });
users.add({ id: 'ana' });
await axeda.start();
await axeda.bootstrap({ userId: 'root' }); // la primera administración global
const root = { userId: 'root' };
const viewer = (await axeda.roles.list(root, { limit: 50 })).items.find((r) => r.key === 'viewer');
await axeda.assignments.assign(root, {
  userId: 'ana',
  roleId: viewer!.id,
  scope: { type: 'global' },
});

await axeda.can({ userId: 'ana' }, 'invoice:read'); // true
await axeda.can({ userId: 'nobody' }, 'invoice:read'); // false: se deniega por defecto
```

Úsalo para pruebas unitarias de tu propia lógica de autorización. Conserva unas pocas pruebas
contra la pila real (Better Auth + SQLite en memoria) para comprobar el cableado: la suite de la
aplicación de ejemplo sirve de plantilla,
[`apps/example/test/example.test.ts`](../../apps/example/test/example.test.ts).

## Tu propio almacén

Si implementas el puerto de persistencia para otra base de datos, ejecuta la suite de contrato
contra ella:

```ts
import { runPersistenceContract } from '@teamblind/axeda-testing';

// La fábrica recibe los ids de usuario que necesita la suite; créalos en tu base de datos.
runPersistenceContract('mi base de datos', async (userIds) => createMyPersistence(userIds));
```

## Contra un servidor PostgreSQL real

Por omisión, las pruebas del propio repositorio usan SQLite y un PostgreSQL dentro del proceso
(PGlite). Define `AXEDA_TEST_POSTGRES_URL` y las mismas pruebas corren además contra un servidor
real con un grupo de 10 conexiones, creando y borrando una base de datos por prueba:

```bash
AXEDA_TEST_POSTGRES_URL=postgres://usuario:clave@localhost:5432/postgres npm test
```

Las pruebas de concurrencia afirman invariantes que deben cumplirse sin importar cuántos
escritores compitan (un ganador entre N ediciones idénticas, el límite de asignaciones nunca
rebasado, ninguna subida de versión perdida). Con una sola conexión comprueban la lógica; con un
servidor y un grupo de conexiones los escritores se superponen de verdad.

Trampas que nos enseñaron la suite y las pruebas reales:

- **Nunca consultes dentro de una transacción con nada que no sean los almacenes de esa
  transacción.** En una base de una sola conexión (SQLite) la consulta espera para siempre a la
  conexión que tiene la transacción. Dentro de los hooks de Better Auth, usa `internalAdapter`.
- **Cierra las bases de datos tras cada prueba**; los manejadores de SQLite en memoria sin cerrar
  pueden tumbar los procesos de prueba.
- **El limitador de peticiones de Better Auth es de todo el proceso.** Las pruebas que registran
  muchos usuarios deben enviar un `X-Forwarded-For` distinto por usuario, como hacen las del ejemplo.
