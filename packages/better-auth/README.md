# @teamblind/axeda-better-auth

The Better Auth plugin for Axeda: schema, `/axeda/*` endpoints, the typed client, `secureAuthOptions()` and the stores that persist everything through Better Auth's database adapter. It runs on SQLite, PostgreSQL, MySQL and MongoDB.

> **Status:** alpha (`0.1.0-alpha.1`); the API can still change before 1.0. Install with `npm install @teamblind/axeda-better-auth@alpha better-auth @better-auth/core`. Documentation: [English](https://github.com/teamblindmx/axeda/tree/main/docs/en) · [Español](https://github.com/teamblindmx/axeda/tree/main/docs/es).

## Install

```bash
npm install @teamblind/axeda-better-auth@alpha better-auth @better-auth/core
# to protect Express routes as well:
npm install @teamblind/axeda-express@alpha express
```

Node.js 22 or later. ES modules only. Peer dependencies: `better-auth` and `@better-auth/core` (`^1.7.10`; tested on 1.7.10 and 1.7.17).

## Use

```ts
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { axeda, secureAuthOptions } from '@teamblind/axeda-better-auth';

const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create'],
  roles: { viewer: { name: 'Viewer', permissions: ['invoice:read'] } },
});

const options = {
  ...secureAuthOptions({
    baseURL: 'https://api.example.com',
    secret: process.env.BETTER_AUTH_SECRET!, // at least 32 random characters
    trustedOrigins: ['https://app.example.com'],
  }),
  database, // see "Databases" below
  plugins: [axedaPlugin],
  emailVerification: { sendOnSignUp: true, sendVerificationEmail }, // yours
};

await (await getMigrations(options)).runMigrations(); // SQL databases; MongoDB needs none
const auth = betterAuth(options);
await auth.$context;
await axedaPlugin.start(); // checks the database has real transactions, syncs your roles
```

From the browser:

```ts
import { createAuthClient } from 'better-auth/client';
import { axedaClient } from '@teamblind/axeda-better-auth/client';

const client = createAuthClient({ baseURL: 'https://api.example.com', plugins: [axedaClient()] });
```

## What you configure

Axeda reads no environment variables: everything is passed in code.

| You configure…                      | With                         | Required                                           |
| ----------------------------------- | ---------------------------- | -------------------------------------------------- |
| Better Auth: URLs, secret, sessions | `secureAuthOptions({ … })`   | `baseURL`, `secret`, `trustedOrigins`              |
| Better Auth: the rest               | your own `betterAuth({ … })` | `database`, `plugins`, a verification email sender |
| What Axeda manages                  | `axeda({ … })`               | `permissions`                                      |

Every option, its accepted values, its default and what happens when it is wrong are in the
[Configuration guide](https://github.com/teamblindmx/axeda/blob/main/docs/en/configuration.md).

## Databases

| Database   | What you give Better Auth                                  | Checked in the CI       |
| ---------- | ---------------------------------------------------------- | ----------------------- |
| SQLite     | `new Database(file)` from `better-sqlite3`                 | In memory               |
| PostgreSQL | `new pg.Pool({ connectionString })`                        | 16 and 18, real servers |
| MySQL      | `createPool({ uri, timezone: 'Z' })` from `mysql2/promise` | 8.4 and 9, real servers |
| MongoDB    | `mongodbAdapter(db, { client })`, on a replica set         | 7.0, a real replica set |

Axeda refuses to start on a database without real transactions. MySQL and MongoDB have settings of their
own: see [Databases](https://github.com/teamblindmx/axeda/blob/main/docs/en/reference.md#databases).

## Guides

- [Quick start](https://github.com/teamblindmx/axeda/blob/main/docs/en/quickstart.md): run the example, then add Axeda to your app.
- [Configuration](https://github.com/teamblindmx/axeda/blob/main/docs/en/configuration.md): every option, the startup order and a production checklist.
- [Reference](https://github.com/teamblindmx/axeda/blob/main/docs/en/reference.md): endpoints, error codes and the TypeScript API.
- [Security](https://github.com/teamblindmx/axeda/blob/main/docs/en/security.md): what `secureAuthOptions()` fixes and what stays yours.
- [Upgrading](https://github.com/teamblindmx/axeda/blob/main/docs/en/upgrading.md): from `0.1.0-alpha.0`.

Part of [Axeda](https://github.com/teamblindmx/axeda), hierarchical authorization (global → company → business) on top of [Better Auth](https://www.better-auth.com). Licensed under [Apache-2.0](LICENSE).
