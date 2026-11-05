# Configuration

Axeda reads **no environment variables**. Everything is configured in code, by passing options to
four functions. Where a value comes from (an environment variable, a secret manager, a file) is up to
your application; the [last section](#environment-variables) shows a typical layout.

| You configure…                         | With                                                           | Required                                                   |
| -------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Better Auth: URLs, secret, sessions    | [`secureAuthOptions({ … })`](#1-better-auth-secureauthoptions) | `baseURL`, `secret`, `trustedOrigins`                      |
| Better Auth: the rest                  | your own `betterAuth({ … })` call                              | `database`, `plugins`, a verification email sender         |
| What Axeda manages                     | [`axeda({ … })`](#2-the-plugin-axeda)                          | `permissions`                                              |
| The routes of your Express application | [`createAxedaExpress({ … })`](#3-express-createaxedaexpress)   | `axeda`, `principal`, and `trustedOrigins` or `csrf:false` |

The shortest working setup, in the order it has to run, is in the [Quick start](quickstart.md#2-add-axeda-to-your-app).
This page explains every option, what values are accepted and what happens when one is wrong.

## When a mistake shows up

| Mistake                                                                            | Shows up…                                         | As                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `maxSessionAge` not a positive whole number                                        | when you call `axeda({ … })`                      | `AXEDA_INVALID_CONFIG`                                   |
| Any other plugin option out of range, malformed or misspelled **inside** an object | when Better Auth is created (`betterAuth({ … })`) | `AXEDA_INVALID_CONFIG`, with the path and the reason     |
| A weak `secureAuthOptions` input                                                   | when you call `secureAuthOptions({ … })`          | `AXEDA_INVALID_CONFIG`                                   |
| A Better Auth option Axeda will not run with                                       | when Better Auth is created                       | `AXEDA_INVALID_CONFIG`                                   |
| The Axeda tables do not exist (you did not migrate)                                | at `start()`, or at the first request             | the database's own error (`no such table: axedaState` …) |
| The database has no real transactions                                              | at `start()`                                      | `AXEDA_TRANSACTIONS_UNSUPPORTED`                         |
| A misspelled option at the **top level** of `axeda({ … })` (`invitationDelivry`)   | **never**: it is ignored                          | the feature is simply off. Check the spelling            |

Configuration errors never reach a browser as such: an HTTP client sees `AXEDA_INTERNAL_ERROR` and the
detail stays in your server log ([error codes](reference.md#error-codes)).

---

## 1. Better Auth: `secureAuthOptions`

`secureAuthOptions(input)` returns the part of Better Auth's configuration that Axeda recommends. You
spread it into your own configuration and add what only you know. It **refuses to return** a weak
configuration (it throws `AXEDA_INVALID_CONFIG`).

```ts
import { betterAuth } from 'better-auth';
import { axeda, secureAuthOptions } from '@teamblind/axeda-better-auth';

const options = {
  ...secureAuthOptions({
    baseURL: 'https://api.example.com',
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: ['https://app.example.com'],
  }),
  database, // yours
  plugins: [axedaPlugin], // yours
  emailVerification: { sendOnSignUp: true, sendVerificationEmail }, // yours
};
```

### Input

| Option                     | Type                                            | Default        | What it does, and what is checked                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`                  | `string`                                        | — (required)   | Public URL of the server that runs Better Auth. It may carry a path (`/api/auth`); only its origin is checked. In `production` it must be `https`; in `development`, `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`             |
| `secret`                   | `string`                                        | — (required)   | At least **32 characters** and at least **8 different ones**: a short or repetitive secret is refused. Generate one with `openssl rand -base64 48`                                                                                                |
| `trustedOrigins`           | `string[]`                                      | — (required)   | The front ends allowed to call the API with a cookie, and to be redirected to. At least one. Each must be just an origin (`https://app.example.com`: no path, no query, no credentials) and **no wildcards**. `baseURL` already counts as trusted |
| `environment`              | `'production' \| 'development'`                 | `'production'` | `production` demands `https` everywhere and `Secure` cookies. `development` allows `http://localhost`                                                                                                                                             |
| `trustedProxies`           | `string[]` (IPs or CIDR ranges)                 | `[]`           | The proxies in front of your API. Without them only a single-valued `X-Forwarded-For` is trusted, because a chain can be forged by the client and used to evade rate limits. Set it if you run behind a proxy                                     |
| `rateLimitStorage`         | `'memory' \| 'database' \| 'secondary-storage'` | `'memory'`     | Where request counts live. `memory` is per process: with several instances the real limit is multiplied by the number of instances. **Use `database` with more than one instance**                                                                |
| `requireEmailVerification` | `boolean`                                       | `true`         | Sign-in needs a verified email. Invitations are only accepted by a verified email, so `false` is refused in `production`. With `true` you must configure `emailVerification.sendVerificationEmail`                                                |

### What it sets for you

| Area          | Value                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords     | 12 to 128 characters; sessions are revoked on password reset                                                                                                                                                                                         |
| Sessions      | `expiresIn` 7 days (idle time), `updateAge` 1 day, `freshAge` 15 minutes, **cookie cache off**                                                                                                                                                       |
| Cookies       | `HttpOnly`, `SameSite=Lax`, `Secure` in production                                                                                                                                                                                                   |
| Origin checks | `disableCSRFCheck: false`, `disableOriginCheck: false`                                                                                                                                                                                               |
| Rate limits   | 100 requests per minute per address, and stricter on sign-in (5 per minute), sign-up (5 per 5 minutes), password reset request (3 per 5 minutes), reset (5 per 5 minutes), verification email (3 per 5 minutes) and TOTP verification (5 per minute) |

You can override any of these by placing your own value **after** the spread. The spread is shallow:
your `session` (or `advanced`, `rateLimit`, `emailAndPassword`) replaces the whole preset object, so
copy the values you still want. Axeda only refuses the four options below.

### What you add yourself

- `database`: see [Databases](reference.md#databases) for what each one needs.
- `plugins: [axedaPlugin]`, plus Better Auth's `twoFactor` plugin if any role uses `requireMfa`.
- `emailVerification.sendVerificationEmail`, required by the default `requireEmailVerification: true`.
- `secondaryStorage`, if you use one. With it, Axeda reads the user from the database on every request (one
  more query), because Better Auth refreshes the user copy inside cached sessions but Axeda's permission
  version is not part of that refresh.

### Options Axeda will not run with

If any of these is `true` when Better Auth is created, Axeda throws `AXEDA_INVALID_CONFIG` and the message
says why. They remove a protection every `/axeda/*` endpoint relies on.

| Option                                 | Why it is refused                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `session.cookieCache.enabled`          | A revoked session or a changed permission would stay valid until the cookie expires |
| `advanced.disableCSRFCheck`            | Every `/axeda/*` endpoint uses a cookie and would be open to cross-site requests    |
| `advanced.disableOriginCheck`          | Callback and redirect URLs would no longer be checked against `trustedOrigins`      |
| `advanced.ipAddress.disableIpTracking` | Rate limits and the audit log need the client address                               |

Axeda also adds its own limit to its endpoints, per IP address: **120 requests per minute** for `/axeda/*`
and **30 per minute** for the one endpoint that needs no session (`/axeda/public/identity`).

---

## 2. The plugin: `axeda`

```ts
const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create'],
  roles: { viewer: ['invoice:read'] },
});
```

Only `permissions` is required. Every other option has a default.

### Options

| Option                         | Type                                         | Default      | Accepted values                           | Notes                                                                                    |
| ------------------------------ | -------------------------------------------- | ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `permissions`                  | `string[]`                                   | — (required) | see [Permission keys](#permission-keys)   | The catalog of your application                                                          |
| `roles`                        | `Record<string, string[] \| RoleDefinition>` | `{}`         | see [Roles](#roles-declared-in-code)      | Roles that ship with your app, created and kept in sync by `start()`                     |
| `menus`                        | `MenuDefinition[]`                           | `[]`         | see [Menu items](reference.md#menu-items) | Served by `GET /axeda/menu`, filtered by what the caller may do                          |
| `retention.graceDays`          | integer                                      | `30`         | 0 to 3650                                 | Days a deleted company or business is kept before it can be purged                       |
| `invitations.ttlHours`         | integer                                      | `72`         | 1 to 720                                  | Default life of an invitation                                                            |
| `invitations.maxRoles`         | integer                                      | `10`         | 1 to 50                                   | Roles one invitation may carry                                                           |
| `limits.maxAssignmentsPerUser` | integer                                      | `50`         | 1 to 10000                                | A grant (or an accepted invitation) over the limit answers `AXEDA_LIMIT_EXCEEDED`        |
| `limits.maxPermissionsPerRole` | integer                                      | `100`        | 1 to 10000                                | A role with more permissions than this is refused                                        |
| `limits.maxCachedUsers`        | integer                                      | `10000`      | 1 to 10000                                | Users whose permissions each process keeps in memory. Memory grows with this value       |
| `invitationDelivery`           | `{ acceptUrl(token), send(message) }`        | off          | two functions                             | Without it, creating an invitation answers `AXEDA_FEATURE_DISABLED` (501)                |
| `publicIdentity`               | `boolean`                                    | `false`      | `true` / `false`                          | Publishes `GET /axeda/public/identity`, the only endpoint that needs no session          |
| `maxSessionAge`                | positive integer (seconds) or `false`        | 30 days      | `> 0`, or `false` to turn it off          | Longest a session lives from sign-in, however much it is used. Checked at `axeda({ … })` |
| `clock`                        | `{ now(): Date }`                            | system clock | —                                         | For tests only                                                                           |

Misspelled keys **inside** `retention`, `invitations`, `limits` or a role definition are rejected. A
misspelled key at the **top level** is ignored (see [the table above](#when-a-mistake-shows-up)).

### Permission keys

A permission is `resource:action` (`invoice:create`) or `resource:sub:action` (`report:sales:read`).

- 2 or 3 segments separated by `:`.
- Each segment: lowercase letters, digits, `_` or `-`; it starts with a letter; at most 32 characters.
- In a role (not in the catalog) the last segment may be `*` (`invoice:*`), and `*` alone grants everything.
- The catalog (`permissions`) holds concrete keys: **no wildcards**, no duplicates, and nothing that starts
  with `axeda:` (reserved for Axeda's own permissions).

### Roles declared in code

`roles` maps a key to a list of permissions, or to a definition:

```ts
roles: {
  viewer: ['invoice:read'],
  cashier: { name: 'Cashier', description: 'Takes payments', permissions: ['invoice:*'], requireMfa: true },
}
```

| Field         | Default | Accepted values                                                                                                                                                              |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key           | —       | Lowercase, starts with a letter; letters, digits, `_` and `-`; at most 64 characters                                                                                         |
| `permissions` | —       | At least one; at most `limits.maxPermissionsPerRole`. Wildcards are allowed here (`invoice:*`, `*`), but each entry must cover something in the catalog, so a typo is caught |
| `name`        | the key | 1 to 200 characters                                                                                                                                                          |
| `description` | none    | Up to 1000 characters                                                                                                                                                        |
| `requireMfa`  | `false` | The role grants nothing to a user without two-factor authentication. Needs Better Auth's `twoFactor` plugin                                                                  |

Roles declared here are **managed**: `start()` creates them and keeps them in sync with your code, and the
API refuses to edit them (`AXEDA_ROLE_MANAGED`). Roles created through the API are yours to change.

### Delivering invitations

```ts
invitationDelivery: {
  acceptUrl: (token) => `https://app.example.com/accept?token=${encodeURIComponent(token)}`,
  send: async ({ email, link }) => mailer.send({ to: email, subject: 'You are invited', link }),
},
```

- Build `acceptUrl` from **your configured base URL**, never from a request's `Host` header.
- `send` receives data, not HTML: escape whatever you put in a message. If it throws, the caller gets
  `AXEDA_DELIVERY_FAILED` (502).

### Session lifetime

Two limits apply, and the shorter one wins:

- Better Auth's `session.expiresIn` (7 days with the preset) is the **idle** time: it renews while the
  session is used.
- `maxSessionAge` (30 days by default) is the **absolute** time since sign-in. After it, the user signs
  in again, however recently they were active.

While the limit holds a session back, Better Auth writes the session row on every request during the
last `expiresIn` minus `updateAge` of its life (6 days with the preset), instead of once a day.

---

## 3. Express: `createAxedaExpress`

```ts
const x = createAxedaExpress({
  axeda: axedaPlugin.instance(),
  principal: sessionPrincipal(auth),
  trustedOrigins: ['https://app.example.com'],
  onDenied: (event) => logger.warn(event, 'request denied'),
});
```

| Option           | Type                                 | Required         | What it does                                                                                                                               |
| ---------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `axeda`          | `Axeda`                              | yes              | `axedaPlugin.instance()`; available after Better Auth is created                                                                           |
| `principal`      | `({ headers }) => Principal \| null` | yes              | Who is calling. With Better Auth, `sessionPrincipal(auth)`. Never build it from request data                                               |
| `trustedOrigins` | `string[]`                           | one of these two | Origins allowed to send a write that carries a cookie (CSRF defence). Use the front ends of your app                                       |
| `csrf`           | `false`                              | one of these two | Only if this API never authenticates with cookies                                                                                          |
| `onDenied`       | `(event) => void \| Promise<void>`   | no               | Called after every denial so you can log it. It cannot change the response, and an error in it is ignored. Axeda writes no logs of its own |

You must decide between `trustedOrigins` and `csrf: false`; the types do not accept both or neither.

Each guarded route takes `x.requirePermission(permission, { scope, onDeny })`:

| Option   | Default       | What it does                                                                                                                      |
| -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `scope`  | global        | Where the permission is checked, from the request (`resolveScope({ company: 'companyId' })`). See [Protecting routes](express.md) |
| `onDeny` | `'forbidden'` | `'forbidden'` answers 403; `'not-found'` answers 404, the same whether the resource is missing or just not yours                  |

---

## Starting up, in order

1. **Create the options.** `secureAuthOptions({ … })` and `axeda({ … })` throw on bad input.
2. **Migrate the database.** On SQL databases run Better Auth's migration, which creates the Axeda tables
   and indexes:
   ```ts
   await (await getMigrations(options)).runMigrations();
   ```
   MongoDB has no migrations: the adapter creates collections and indexes on first use.
   On a large existing SQL database, building a new index can block writes to that table while it runs:
   pick a quiet moment.
3. **Create Better Auth:** `const auth = betterAuth(options); await auth.$context;`. This validates the
   plugin options and the four refused options.
4. **`await axedaPlugin.start()`.** Checks that the database really has transactions and creates or updates
   your managed roles. Call it at boot so a problem stops the process instead of the first request.
   It is safe to call more than once. A brief database outage is retried on the next call;
   `AXEDA_INVALID_CONFIG` and `AXEDA_TRANSACTIONS_UNSUPPORTED` are permanent and are not.
5. **Create the first administrator**, once, from a server-side script (it is not an endpoint, so there is
   no password to guard):
   ```ts
   await axedaPlugin.instance().bootstrap({ userId });
   ```
   It refuses with `AXEDA_ALREADY_BOOTSTRAPPED` while a global administrator exists. If the last one
   disappears it works again, and that is the recovery path.
6. **Mount** Better Auth's handler **before** `express.json()`, then your guarded routes.

## Database-specific settings

| Database   | What you must set                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite     | Nothing                                                                                                                                                                    |
| PostgreSQL | A `pg.Pool`                                                                                                                                                                |
| MySQL      | The pool from `mysql2/promise`, with `timezone: 'Z'`; `advanced.database.validateSchema: false` if the server lowercases table names; bound `audit.action` on an old table |
| MongoDB    | `mongodbAdapter(db, { client })` on a **replica set** (one node is enough)                                                                                                 |

The reasons and the exact steps are in [Databases](reference.md#databases).

## Environment variables

The library does not read any. A typical application reads them at boot, **fails if one is missing**, and
passes the values in. The example application (`apps/example`) does this and is a good model:

| Variable                | Passed as        | Notes                                                                    |
| ----------------------- | ---------------- | ------------------------------------------------------------------------ |
| `BASE_URL`              | `baseURL`        | Public URL of the server. No default                                     |
| `BETTER_AUTH_SECRET`    | `secret`         | At least 32 random characters. No default. Keep it out of the repository |
| `TRUSTED_ORIGINS`       | `trustedOrigins` | Comma-separated. The example falls back to `BASE_URL` if empty           |
| `TRUSTED_PROXIES`       | `trustedProxies` | Comma-separated IPs or CIDR ranges                                       |
| `NODE_ENV`              | `environment`    | `production` or `development`                                            |
| `PORT`, `DATABASE_FILE` | —                | Specific to the example (listening port and SQLite file)                 |

The `AXEDA_TEST_*` variables belong to the test suite and the benchmark, not to your application.

## Production checklist

- [ ] `baseURL` and every `trustedOrigins` entry use `https`, with no wildcards.
- [ ] `secret` is random, at least 32 characters, and lives in a secret manager, not in the repository.
- [ ] `environment` is `production` (the default).
- [ ] Behind a proxy: `trustedProxies` lists it.
- [ ] More than one instance: `rateLimitStorage: 'database'`.
- [ ] `emailVerification.sendVerificationEmail` sends real mail.
- [ ] `invitationDelivery.acceptUrl` is built from your configured URL, not from `Host`.
- [ ] The migration has run, and `start()` runs at boot.
- [ ] Roles that use `requireMfa` have Better Auth's `twoFactor` plugin installed.
- [ ] `maxSessionAge` matches your policy (30 days by default).
- [ ] The first administrator was created with `bootstrap`.
- [ ] You archive the audit log yourself: retention is not automatic and the table only grows.
- [ ] MongoDB runs as a replica set; MySQL tables created before the `action` index were bounded.

## Troubleshooting

| You see                                                                 | Cause and fix                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AXEDA_INVALID_CONFIG … Unrecognized key`                               | A misspelled key inside `retention`, `invitations`, `limits` or a role. The message gives the path                 |
| `AXEDA_INVALID_CONFIG … Too big: expected number to be <=…`             | A number above its range. See the [options table](#options)                                                        |
| `AXEDA_INVALID_CONFIG … permission "…" …`                               | A malformed, wildcard, duplicated or `axeda:`-prefixed key in the catalog; see [Permission keys](#permission-keys) |
| `AXEDA_INVALID_CONFIG … role "…" uses "…", which matches no permission` | A role lists a permission your catalog does not cover. Usually a typo                                              |
| `AXEDA_INVALID_CONFIG … The secret …`                                   | `secret` is shorter than 32 characters or too repetitive                                                           |
| `AXEDA_INVALID_CONFIG … must use https`                                 | A URL is `http` in production. Use `https`, or `environment: 'development'` on `localhost`                         |
| `AXEDA_INVALID_CONFIG … requireEmailVerification: false …`              | `false` is only for development                                                                                    |
| `AXEDA_INVALID_CONFIG … Axeda cannot run with …`                        | One of the [four refused options](#options-axeda-will-not-run-with). Remove it                                     |
| `no such table: axedaState` (or another Axeda table)                    | The migration has not run on this database                                                                         |
| `AXEDA_TRANSACTIONS_UNSUPPORTED`                                        | No real transactions: on MongoDB use a replica set and pass `client`; on SQL pass a database Better Auth supports  |
| Creating an invitation answers `AXEDA_FEATURE_DISABLED`                 | `invitationDelivery` is not configured. Check its spelling too                                                     |
| `GET /axeda/public/identity` answers 404                                | `publicIdentity` is `false` (the default)                                                                          |
| `429` from sign-in or sign-up                                           | The preset's rate limits. Wait, or raise them by overriding `rateLimit` after the spread                           |
