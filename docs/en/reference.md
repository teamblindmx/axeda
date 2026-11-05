# Reference

## Plugin options (`axeda({ … })`)

| Option                         | Type                                                                         | Default | Meaning                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `permissions`                  | `string[]`                                                                   | —       | Your permission catalog (concrete, no wildcards). **Required**             |
| `roles`                        | `Record<key, string[] \| { name?, description?, permissions, requireMfa? }>` | `{}`    | Managed roles, synchronised at startup                                     |
| `menus`                        | `MenuDefinition[]`                                                           | `[]`    | The menu, declared in code                                                 |
| `retention.graceDays`          | `number` (0–3650)                                                            | `30`    | Days a deleted company or business can be restored                         |
| `invitations.ttlHours`         | `number`                                                                     | `72`    | Default invitation lifetime                                                |
| `invitations.maxRoles`         | `number` (1–50)                                                              | `10`    | Roles per invitation                                                       |
| `limits.maxAssignmentsPerUser` | `number`                                                                     | `50`    | Assignments one user may hold                                              |
| `limits.maxPermissionsPerRole` | `number`                                                                     | `100`   | Permissions in one role                                                    |
| `limits.maxCachedUsers`        | `number`                                                                     | `10000` | Users whose permissions each process keeps cached                          |
| `invitationDelivery`           | `{ acceptUrl(token), send(message) }`                                        | off     | How invitations are delivered. Without it they are disabled                |
| `publicIdentity`               | `boolean`                                                                    | `false` | Exposes `GET /axeda/public/identity` (the only endpoint without a session) |
| `maxSessionAge`                | `number` (seconds) or `false`                                                | 30 days | Longest a session can live from sign-in, however much it is used           |

`acceptUrl` must be built from your configured base URL, never from a request's `Host` header.

### Menu items

| Field           | Notes                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| `key`           | Unique                                                                 |
| `parent`        | Key of an existing group                                               |
| `label`         | A string, or one per language: `{ en: 'Invoices', es: 'Facturas' }`    |
| `path`          | Leaves only. Starts with `/`, no scheme, no `//`, no spaces            |
| `requires`      | Leaves only, **required**. A concrete permission from the catalog      |
| `actions`       | Permissions of buttons on that screen; the menu reports `can` for each |
| `icon`, `order` | Presentation                                                           |

At most 200 items and 3 levels. The label is picked by exact locale, then base language
(`es-MX` → `es`), then `en`, then the plain label, then the first available.

## Endpoints

All live under Better Auth's base path (`/api/auth`). Every one needs a session except the last.
“Per target” means the permission is checked in the scope of the thing being changed.

| Method | Path                          | Requires                                                   | Checked in      |
| ------ | ----------------------------- | ---------------------------------------------------------- | --------------- |
| GET    | `/axeda/me`                   | (authenticated)                                            | own             |
| GET    | `/axeda/permission/list`      | `axeda:role:manage` or `axeda:assignment:manage`           | any             |
| GET    | `/axeda/role/list`            | `axeda:role:manage` or `axeda:assignment:manage`           | any             |
| GET    | `/axeda/role/get`             | `axeda:role:manage` or `axeda:assignment:manage`           | any             |
| POST   | `/axeda/role/create`          | `axeda:role:manage`                                        | global          |
| POST   | `/axeda/role/update`          | `axeda:role:manage`                                        | global          |
| POST   | `/axeda/role/set-status`      | `axeda:role:manage`                                        | global          |
| POST   | `/axeda/role/delete`          | `axeda:role:manage`                                        | global          |
| GET    | `/axeda/assignment/list`      | `axeda:assignment:manage`                                  | per target      |
| POST   | `/axeda/assignment/create`    | `axeda:assignment:manage`                                  | scope parameter |
| POST   | `/axeda/assignment/revoke`    | `axeda:assignment:manage`                                  | per target      |
| GET    | `/axeda/audit/list`           | `axeda:audit:read`                                         | scope parameter |
| GET    | `/axeda/company/list`         | membership                                                 | per target      |
| GET    | `/axeda/company/get`          | membership                                                 | per target      |
| POST   | `/axeda/company/create`       | `axeda:company:manage`                                     | global          |
| POST   | `/axeda/company/update`       | `axeda:company:manage`                                     | per target      |
| POST   | `/axeda/company/set-status`   | `axeda:company:manage`                                     | global          |
| POST   | `/axeda/company/delete`       | `axeda:company:manage`                                     | global          |
| POST   | `/axeda/company/restore`      | `axeda:company:manage`                                     | global          |
| GET    | `/axeda/business/list`        | membership                                                 | per target      |
| GET    | `/axeda/business/get`         | membership                                                 | per target      |
| POST   | `/axeda/business/create`      | `axeda:business:manage`                                    | per target      |
| POST   | `/axeda/business/update`      | `axeda:business:manage`                                    | per target      |
| POST   | `/axeda/business/set-status`  | `axeda:business:manage`                                    | per target      |
| POST   | `/axeda/business/delete`      | `axeda:business:manage`                                    | per target      |
| POST   | `/axeda/business/restore`     | `axeda:business:manage`                                    | per target      |
| GET    | `/axeda/invitation/list`      | `axeda:invitation:manage`                                  | scope parameter |
| POST   | `/axeda/invitation/create`    | `axeda:invitation:manage`                                  | scope parameter |
| POST   | `/axeda/invitation/accept`    | (authenticated; the secret and a verified email authorize) | own             |
| POST   | `/axeda/invitation/revoke`    | `axeda:invitation:manage`                                  | per target      |
| GET    | `/axeda/user/list`            | `axeda:user:manage`                                        | global          |
| POST   | `/axeda/user/create`          | `axeda:user:manage`                                        | global          |
| POST   | `/axeda/user/ban`             | `axeda:user:manage`                                        | global          |
| POST   | `/axeda/user/unban`           | `axeda:user:manage`                                        | global          |
| POST   | `/axeda/user/revoke-sessions` | `axeda:user:manage`                                        | global          |
| GET    | `/axeda/menu`                 | (authenticated; only lists what you may use)               | own             |
| GET    | `/axeda/public/identity`      | (public, off unless `publicIdentity`)                      | —               |

Better Auth endpoints accept only `GET` and `POST`, so updates and deletes are `POST`. Axeda's
endpoints are rate limited per address: 120 per minute, and 30 for `/axeda/public/`. The typed
client mirrors this: `client.axeda.role.create({ … })`, `client.axeda.menu({ query })`.

## Error codes

Errors have the shape `{ code, message }`. The codes are stable; the messages are in English and
may change, so branch on `code`.

| Code                         | Status | Meaning                                                           |
| ---------------------------- | ------ | ----------------------------------------------------------------- |
| `AXEDA_INVALID_INPUT`        | 400    | The input failed validation                                       |
| `AXEDA_INVALID_PERMISSION`   | 400    | Not a well-formed permission                                      |
| `AXEDA_UNKNOWN_PERMISSION`   | 400    | A permission that is not in the catalog                           |
| `AXEDA_INVITATION_INVALID`   | 400    | Wrong, expired, used or revoked invitation, or the email differs  |
| `AXEDA_FORBIDDEN`            | 403    | You may not do this                                               |
| `AXEDA_MFA_REQUIRED`         | 403    | The role needs two-factor authentication the user has not enabled |
| `AXEDA_USER_BANNED`          | 403    | The account is suspended (on sign-in)                             |
| `AXEDA_ROLE_NOT_FOUND`       | 404    |                                                                   |
| `AXEDA_ASSIGNMENT_NOT_FOUND` | 404    |                                                                   |
| `AXEDA_USER_NOT_FOUND`       | 404    |                                                                   |
| `AXEDA_COMPANY_NOT_FOUND`    | 404    |                                                                   |
| `AXEDA_BUSINESS_NOT_FOUND`   | 404    |                                                                   |
| `AXEDA_EMAIL_TAKEN`          | 409    | An account with that email exists                                 |
| `AXEDA_ROLE_KEY_TAKEN`       | 409    |                                                                   |
| `AXEDA_ROLE_MANAGED`         | 409    | The role is declared in code and cannot be changed here           |
| `AXEDA_VERSION_CONFLICT`     | 409    | Someone else changed it first; reload and retry                   |
| `AXEDA_ASSIGNMENT_EXISTS`    | 409    |                                                                   |
| `AXEDA_LIMIT_EXCEEDED`       | 409    | A configured limit was reached                                    |
| `AXEDA_ALREADY_BOOTSTRAPPED` | 409    | A global administrator already exists                             |
| `AXEDA_SLUG_TAKEN`           | 409    |                                                                   |
| `AXEDA_INVITATION_EXISTS`    | 409    | There is already a pending invitation for that email and scope    |
| `AXEDA_FEATURE_DISABLED`     | 501    | Invitations or user administration are not configured             |
| `AXEDA_DELIVERY_FAILED`      | 502    | Your `invitationDelivery.send` threw                              |
| `AXEDA_INTERNAL_ERROR`       | 500    | Anything unexpected; details stay in your server logs             |

Configuration problems (`AXEDA_INVALID_CONFIG`, `AXEDA_TRANSACTIONS_UNSUPPORTED`,
`AXEDA_DATA_CORRUPT`) never reach the client as such: they appear as `AXEDA_INTERNAL_ERROR`.

`@teamblind/axeda-express` adds `AXEDA_UNAUTHENTICATED` (401), `AXEDA_FORBIDDEN` (403), `AXEDA_NOT_FOUND`
(404) and `AXEDA_CROSS_SITE` (403); see [Protecting routes](express.md).

## `secureAuthOptions(input)`

| Input                      | Default        | Notes                                                |
| -------------------------- | -------------- | ---------------------------------------------------- |
| `baseURL`                  | —              | Public URL of the auth server; `https` in production |
| `secret`                   | —              | At least 32 characters, not repetitive               |
| `trustedOrigins`           | —              | At least one; origins only, no wildcards             |
| `environment`              | `'production'` | `'development'` allows `http://localhost`            |
| `trustedProxies`           | none           | IPs or CIDR of your reverse proxies                  |
| `rateLimitStorage`         | `'memory'`     | Use `'database'` with several instances              |
| `requireEmailVerification` | `true`         | `false` only in development                          |

Returns `baseURL`, `secret`, `trustedOrigins`, `emailAndPassword`, `session`, `advanced` and
`rateLimit` to spread into `betterAuth({ … })`. If you override one of these keys, you replace
the whole key, so copy what you still need.

## TypeScript API

Get the instance with `axedaPlugin.instance()` once Better Auth has been created.

| Call                                                                      | Returns                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `can(principal, permission, target?)`                                     | `boolean`; global when no target                                                             |
| `canAnywhere(principal, permission)`                                      | Holds it in any scope?                                                                       |
| `effectivePermissions(principal, target?)`                                | The set of permissions held there                                                            |
| `scopesFor(principal, permission)`                                        | The scopes where it is held                                                                  |
| `scopeFilter(principal, permission)`                                      | `{ unrestricted, companyIds, businessIds }` for your queries                                 |
| `resolveTarget(scope)`                                                    | The checkable target for a company or business id, read from the database; `null` if unknown |
| `menu(principal, { scope?, locale? })`                                    | The filtered menu tree                                                                       |
| `roles`, `assignments`, `companies`, `businesses`, `invitations`, `users` | The same operations the endpoints expose, taking an `actor`                                  |
| `publicIdentity({ company, business? })`                                  | Public name and logos of an active company or business                                       |
| `listAudit(actor, filter, page)`                                          | A page of audit events                                                                       |
| `purgeDeleted()`                                                          | Permanently removes what is past its grace period                                            |
| `bootstrap({ userId })`                                                   | Creates the first global administrator (once)                                                |

A `Principal` is `{ userId, authzVersion?, twoFactorEnabled?, banned? }`. Always build it with
`sessionPrincipal(auth)` or `principalFromUser(row)` from the user row Better Auth just read —
never from request data.

## Databases

Axeda stores its data through Better Auth's database adapter, so it runs on the databases Better
Auth supports **that have real transactions**; it checks this at start and refuses otherwise.

| Database   | What you give Better Auth                                            | Checked in the CI                                         |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| SQLite     | `new Database(file)` from `better-sqlite3`                           | In memory                                                 |
| PostgreSQL | `new pg.Pool({ connectionString })`                                  | 16 and 18, real servers, pool of 10                       |
| MySQL      | `createPool({ uri, timezone: 'Z' })` from `mysql2/promise`           | 8.4 and 9, real servers, pool of 10                       |
| MongoDB    | `mongodbAdapter(db, { client })` from `better-auth/adapters/mongodb` | 7.0, a real single-node replica set (8.0 checked by hand) |

**MongoDB.**

- **A replica set.** MongoDB only runs transactions on a replica set or a sharded cluster, and Axeda
  needs them to keep permission versions consistent. A single-node replica set is enough, also for
  development (`mongod --replSet rs0`, then `rs.initiate()`). Give the adapter the client:
  `mongodbAdapter(db, { client })`; without it Better Auth turns transactions off. On a standalone
  `mongod`, or without the client, Axeda stops at start with `AXEDA_TRANSACTIONS_UNSUPPORTED`.
- **No migrations.** Better Auth's migrations only work on SQL databases. Its MongoDB adapter creates
  each collection and its indexes, the unique ones included, the first time it writes to it; that
  is what keeps a role key, a company slug or a grant of the same role in the same scope unique.
  Before its first transaction Axeda makes one write that matches nothing in each of its collections,
  so that this never happens inside a transaction (MongoDB would make the transaction wait for the
  index until it expires, after 60 seconds). On an existing collection with many documents, that
  first write waits for the index to be built.
- **No foreign keys.** SQL databases refuse a grant to a role or a user that does not exist, and
  delete a user's grants with the user. On MongoDB Axeda checks before writing and deletes the grants
  with a hook when a user is deleted. A grant that races with the deletion of its role can leave an
  assignment to a role that no longer exists; it is ignored when permissions are computed, so it
  grants nothing.
- **Concurrent grants by the same administrator are slower.** A grant locks the administrator's own
  row. SQL makes the next grant wait for it; MongoDB aborts it and Axeda retries the transaction.
  The result is the same, but the time is less even. In a local test (one laptop, MongoDB 8.0, one
  node) a grant took 14 to 16 ms one at a time, and with 16 at the same time the 95th percentile
  went above one second and 50 to 60 grants per second were applied, against 150 to 180 on
  PostgreSQL in the CI. Checking permissions is not affected: it costs the same number of queries
  as on SQL, which the benchmark counts.
- Better Auth accepts version 6 or 7 of the `mongodb` driver; the CI runs 7.

**MySQL.**

- Give Better Auth the pool from `mysql2/promise`, not the one from `mysql2`, and set
  `timezone: 'Z'`. Without it the driver converts dates to the local time of your process, and a
  server in another zone (or a daylight-saving change) shifts them.
- **Table names.** Better Auth validates the schema at start and in authentication requests, and it
  compares table names with their case. A server that stores them in lowercase
  (`lower_case_table_names` 1 or 2: Windows, macOS and some managed services) makes it report
  Axeda's tables (`axedaRole`, `axedaAssignment`…) as missing, and authentication requests fail with
  “Database schema mismatch”. Either run the server with `lower_case_table_names=0` (the default
  on Linux; it can only be chosen when the server is first initialised), or turn that check off
  with `advanced: { database: { validateSchema: false } }`, which also stops checking the rest of
  your schema. The CI covers Linux; the second option was checked against a Windows server.
- Text columns use the server's default collation, which does not tell `A` from `a`. It changes
  nothing for Axeda: role keys, slugs and permission keys are lowercase by validation.
- **Upgrading an existing database.** The audit log has an index on `action` since the version
  after 0.1.0-alpha.0. Better Auth creates string columns without an index as `text`, and on MySQL
  it will not index an existing `text` column: the migration stops with “can exceed MySQL's
  3072-byte index-key limit”. Before running it, bound the column once:
  `ALTER TABLE axedaAudit MODIFY action varchar(255) NOT NULL;`. A new database is not affected.

## Performance

Measured by `npm run bench` on a GitHub-hosted Linux runner, with PostgreSQL 18 on the same machine and a pool of 10 connections. These are the numbers of one run on a shared machine, so read them as an order of magnitude, not a promise; run the benchmark against your own database for yours.

| What                                                        | p50 (ms) | p95 (ms) | Queries |
| ----------------------------------------------------------- | -------: | -------: | ------: |
| `can()`, warm cache, user version already known (a session) |     0.31 |     0.43 |       1 |
| `can()`, warm cache, user version read from the database    |     0.68 |     1.03 |       2 |
| `can()`, cold cache (first time for that person)            |     2.05 |     2.51 |       5 |
| `can()` right after a role everyone holds was edited        |     1.97 |     2.97 |       5 |
| A route: resolve the company, then `can()`                  |     0.66 |     0.86 |       2 |
| A route: resolve the business and its company, then `can()` |     0.96 |     1.24 |       3 |
| Audit log page of 50, 20,000 events, no filter              |     0.75 |     1.47 |       1 |
| The same, filtered by a person who wrote half of the events |     0.75 |     1.90 |       1 |
| The same, filtered by a rare action (5 events)              |     0.39 |     0.42 |       1 |
| Granting a role, one at a time                              |     6.83 |     8.51 |       — |
| Granting a role, 16 at a time                               |    71.26 |   187.48 |       — |

Checking permissions is the frequent operation and costs one cheap query once the cache is warm. Editing a role does not stall anyone: the next check of each person simply takes the cold path (about 2 ms). Administration is rare and heavier on purpose: a grant is one transaction that also writes the audit record, and grants made by the same person are applied one at a time (their own permissions cannot change while they grant), so one person tops out between 150 and 180 grants per second in the last run however many requests are in flight.

The table above is `can()` on its own. A route that first resolves a company or a business from the database (Axeda never trusts the identifier a request sends) pays for that too: **2 queries** for a company and **3** for a business once the cache is warm and the session carries the user's version, one more if it does not. The benchmark counts them and fails if they grow. It also measures the paginated lists on a large audit log and a large scope, and how many times Better Auth writes the session per request. At this size the audit log filtered by a very active person used to be the least steady list: across four earlier CI runs (PostgreSQL 16 and 18) the same page took 0.82, 10.51, 13.39 and 13.70 ms. `EXPLAIN` on real PostgreSQL 16 and 18 explained it: the benchmark measured a table that had just been bulk loaded, before PostgreSQL had computed statistics for it, and without them it picks a plan that sorts every row of that person (about 50 ms at 20,000 events and 470 to 570 ms at 200,000); with statistics it walks the primary key backwards. The benchmark now runs `ANALYZE` after seeding, and the page takes 0.75 ms (p50) on PostgreSQL 18 and 0.36 ms on 16. In a running system autovacuum does this on its own, but the minutes after a very large import can be slow until it does. The search for a rare action used to read the whole table (30 to 74 ms at 200,000 events, growing with the log), so the schema now indexes `action`: with 20,000 events it takes 0.39 ms (p50) on PostgreSQL 18 and 0.16 ms on 16. The unfiltered page and the lists by scope stay under 2 ms at p95.
