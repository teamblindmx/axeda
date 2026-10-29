# Testing

`@axeda/testing` gives you the same Axeda, without a database: in-memory stores that pass the
same contract suite as the real ones.

```ts
import { createAxeda } from '@axeda/core';
import { createMemoryPersistence, createMemoryUserDirectory } from '@axeda/testing';

const users = createMemoryUserDirectory([]);
const axeda = createAxeda(
  { permissions: ['invoice:read'], roles: { viewer: ['invoice:read'] } },
  { persistence: createMemoryPersistence(), users, userAdmin: users },
);

users.add({ id: 'root' });
users.add({ id: 'ana' });
await axeda.start();
await axeda.bootstrap({ userId: 'root' }); // the first global administrator
const root = { userId: 'root' };
const viewer = (await axeda.roles.list(root, { limit: 50 })).items.find((r) => r.key === 'viewer');
await axeda.assignments.assign(root, {
  userId: 'ana',
  roleId: viewer!.id,
  scope: { type: 'global' },
});

await axeda.can({ userId: 'ana' }, 'invoice:read'); // true
await axeda.can({ userId: 'nobody' }, 'invoice:read'); // false: deny by default
```

Use it for unit tests of your own authorization logic. Keep a few tests against the real stack
(Better Auth + SQLite in memory) for the wiring: the example application's test suite is a
template, [`apps/example/test/example.test.ts`](../../apps/example/test/example.test.ts).

## Your own store

If you implement the persistence port for another database, run the contract suite against it:

```ts
import { runPersistenceContract } from '@axeda/testing';

// The factory receives the user ids the suite needs; create them in your database.
runPersistenceContract('my database', async (userIds) => createMyPersistence(userIds));
```

Pitfalls the suite and the real tests taught us:

- **Never query inside a transaction through anything but the transaction's own stores.** On a
  single-connection database (SQLite) the query waits for the connection the transaction holds,
  forever. Inside Better Auth hooks, use `internalAdapter`.
- **Close databases after each test**; unclosed in-memory SQLite handles can crash test workers.
- **Better Auth's rate limiter is process-wide.** Tests that sign up many users should send a
  distinct `X-Forwarded-For` per user, as the example's tests do.
