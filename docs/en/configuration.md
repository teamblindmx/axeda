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

| Mistake                                                                                   | Shows up…                                            | As                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `maxSessionAge` not a positive whole number                                               | when you call `axeda({ … })`                         | `AXEDA_INVALID_CONFIG`                                      |
| Any other plugin option out of range, malformed or misspelled **inside** an object        | when Better Auth is created (`betterAuth({ … })`)    | `AXEDA_INVALID_CONFIG`, with the path and the reason        |
| A weak `secureAuthOptions` input                                                          | when you call `secureAuthOptions({ … })`             | `AXEDA_INVALID_CONFIG`                                      |
| A Better Auth option Axeda will not run with                                              | when Better Auth is created                          | `AXEDA_INVALID_CONFIG`                                      |
| The Axeda tables do not exist (you did not migrate)                                       | at `start()`, or at the first request                | the database's own error (`no such table: axedaState` …)    |
| The database has no real transactions                                                     | at `start()`                                         | `AXEDA_TRANSACTIONS_UNSUPPORTED`                            |
| A misspelled option (`invitationDelivry`, `scop`, `trustedProxys`…) in any Axeda function | when you call it (`axeda()`, `requirePermission()`…) | `AXEDA_INVALID_CONFIG`, naming the option it probably meant |

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

| Area          | Value                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords     | 12 to 128 characters; sessions are revoked on password reset                                                                                                                                                                                                                                                                                                                                                                     |
| Sessions      | `expiresIn` 7 days (idle time), `updateAge` 1 day, `freshAge` 15 minutes, **cookie cache off**                                                                                                                                                                                                                                                                                                                                   |
| Cookies       | `HttpOnly`, `SameSite=Lax`, `Secure` in production                                                                                                                                                                                                                                                                                                                                                                               |
| Origin checks | `disableCSRFCheck: false`, `disableOriginCheck: false`                                                                                                                                                                                                                                                                                                                                                                           |
| Rate limits   | 100 requests per minute per address, and stricter on sign-in (5 per minute), sign-up (5 per 5 minutes), password reset request (3 per 5 minutes), reset (5 per 5 minutes), verification email (3 per 5 minutes), TOTP verification (5 per minute), and the phone routes: send a code (3 per minute), verify it (10 per minute), sign in with a number (5 per minute), request a reset (3 per 5 minutes), reset (5 per 5 minutes) |

You can override any of these by placing your own value **after** the spread. The spread is shallow:
your `session` (or `advanced`, `rateLimit`, `emailAndPassword`) replaces the whole preset object, so
copy the values you still want. Axeda only refuses the four options below.

### What you add yourself

- `database`: see [Databases](reference.md#databases) for what each one needs.
- `plugins: [axedaPlugin]`, plus Better Auth's `twoFactor` plugin if any role uses `requireMfa`, and its
  `phoneNumber` plugin for access by phone ([below](#access-by-phone-number-securephonenumberoptions)).
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

### Access by phone number: `securePhoneNumberOptions`

People can sign up and sign in with their phone number and a one-time code, with no email. Add Better
Auth's `phoneNumber` plugin with the options `securePhoneNumberOptions` returns:

```ts
import { betterAuth } from 'better-auth';
import { phoneNumber } from 'better-auth/plugins';
import { secureAuthOptions, securePhoneNumberOptions } from '@teamblind/axeda-better-auth';

const auth = betterAuth({
  ...secureAuthOptions({ baseURL, secret, trustedOrigins }),
  database, // yours
  plugins: [
    axedaPlugin,
    phoneNumber(
      securePhoneNumberOptions({
        sendOTP: async ({ phoneNumber, code }) => sms.send(phoneNumber, `Your code: ${code}`),
      }),
    ),
  ],
});
```

| Option                 | Type                                               | Default      | What it does                                                                                |
| ---------------------- | -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `sendOTP`              | `({ phoneNumber, code }) => void \| Promise<void>` | — (required) | Sends the code by SMS (or WhatsApp). Never log the code                                     |
| `maxSendsPerNumber`    | `number`                                           | `5`          | Codes sent to **one number** per window, whatever the address asking. Then `429`            |
| `sendWindowSeconds`    | `number`                                           | `3600`       | Length of that window                                                                       |
| `signUpOnVerification` | `boolean`                                          | `true`       | A code for an unknown number creates the account. With `false` it creates nobody: you do it |

What you get:

- Codes of 6 digits, valid 5 minutes; after 3 wrong attempts the code is void.
- Numbers only in E.164 format (`+5215512345678`): anything else is refused before sending.
- The cap per number lives in the database (table `axedaThrottle`), so it holds across instances. Better
  Auth's own limit counts per address, which does not stop someone sending codes to a victim's number
  from many addresses. `secureAuthOptions` also limits the phone routes per address.
- Verifying a code signs the person in. `requireEmailVerification` does not apply to it: it governs email
  sign-in only.
- An account Axeda suspended cannot get back in with a code (`403 AXEDA_USER_BANNED`).
- A person who signs up by phone gets a placeholder email, `<digits>@phone.invalid`, because Better Auth
  needs one. Use `isPhoneOnlyEmail(email)` to hide it. `/axeda/user/list` shows `phoneNumber` and
  `phoneNumberVerified`.
- `/axeda/user/create` still needs an email. To bring in someone who only has a phone, invite them by
  number ([below](#delivering-invitations)) or let them sign up.

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

| Option                         | Type                                         | Default            | Accepted values                           | Notes                                                                                     |
| ------------------------------ | -------------------------------------------- | ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `permissions`                  | `string[]`                                   | — (required)       | see [Permission keys](#permission-keys)   | The catalog of your application                                                           |
| `roles`                        | `Record<string, string[] \| RoleDefinition>` | `{}`               | see [Roles](#roles-declared-in-code)      | Roles that ship with your app, created and kept in sync by `start()`                      |
| `menus`                        | `MenuDefinition[]`                           | `[]`               | see [Menu items](reference.md#menu-items) | Served by `GET /axeda/menu`, filtered by what the caller may do                           |
| `retention.graceDays`          | integer                                      | `30`               | 0 to 3650                                 | Days a deleted company or business is kept before it can be purged                        |
| `retention.auditDays`          | integer                                      | off (kept in full) | 1 to 36500                                | Days audit events are kept; `purgeAudit()` deletes older ones ([below](#audit-retention)) |
| `invitations.ttlHours`         | integer                                      | `72`               | 1 to 720                                  | Default life of an invitation                                                             |
| `invitations.maxRoles`         | integer                                      | `10`               | 1 to 50                                   | Roles one invitation may carry                                                            |
| `limits.maxAssignmentsPerUser` | integer                                      | `50`               | 1 to 10000                                | A grant (or an accepted invitation) over the limit answers `AXEDA_LIMIT_EXCEEDED`         |
| `limits.maxPermissionsPerRole` | integer                                      | `100`              | 1 to 10000                                | A role with more permissions than this is refused                                         |
| `limits.maxCachedUsers`        | integer                                      | `10000`            | 1 to 10000                                | Users whose permissions each process keeps in memory. Memory grows with this value        |
| `invitationDelivery`           | `{ acceptUrl(token), send(message) }`        | off                | two functions                             | Without it, creating an invitation answers `AXEDA_FEATURE_DISABLED` (501)                 |
| `publicIdentity`               | `boolean`                                    | `false`            | `true` / `false`                          | Publishes `GET /axeda/public/identity`, the only endpoint that needs no session           |
| `maxSessionAge`                | positive integer (seconds) or `false`        | 30 days            | `> 0`, or `false` to turn it off          | Longest a session lives from sign-in, however much it is used. Checked at `axeda({ … })`  |
| `clock`                        | `{ now(): Date }`                            | system clock       | —                                         | For tests only                                                                            |

A misspelled key is rejected, at the top level or inside `retention`, `invitations`, `limits`, `images`,
`staff`, `invitationDelivery` or a role definition, with the option it probably meant
(`unknown option "publicIdentiy". Did you mean "publicIdentity"?`).

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
axeda({
  permissions: ['invoice:read', 'invoice:create'],
  roles: {
    viewer: ['invoice:read'],
    cashier: {
      name: 'Cashier',
      description: 'Takes payments',
      permissions: ['invoice:*'],
      requireMfa: true,
    },
  },
});
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
axeda({
  permissions: ['invoice:read'],
  invitationDelivery: {
    acceptUrl: (token) => `https://app.example.com/accept?token=${encodeURIComponent(token)}`,
    send: async ({ channel, email, phoneNumber, link }) =>
      channel === 'phone'
        ? sms.send(phoneNumber ?? '', `You are invited: ${link}`)
        : mailer.send({ to: email, subject: 'You are invited', link }),
  },
});
```

- An invitation goes to an `email` or to a `phoneNumber` (E.164), never both; `channel` says which.
  One by email is accepted only by an account with that email verified; one by phone only by an account
  with that number verified.
- Build `acceptUrl` from **your configured base URL**, never from a request's `Host` header.
- `send` receives data, not HTML: escape whatever you put in a message. If it throws, the caller gets
  `AXEDA_DELIVERY_FAILED` (502).

### Images: logos, favicons and profile pictures

Axeda can keep the logos and favicons of companies, businesses and sites, and profile pictures, in an
object storage (Cloudflare R2, S3, MinIO…). The browser uploads the file **straight to the storage** with a
signed URL; your server never receives the bytes.

```ts
import { axeda } from '@teamblind/axeda-better-auth';
import { s3Storage, sharpImageProcessor } from '@teamblind/axeda-storage';

const axedaPlugin = axeda({
  permissions: ['invoice:read'],
  storage: s3Storage({
    endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
    bucket: 'acme-images',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    publicBaseUrl: 'https://images.acme.com',
  }),
  imageProcessor: sharpImageProcessor(), // optional: npm install sharp
  images: { maxBytes: 2 * 1024 * 1024 },
});
```

In the front end it takes three calls:

```ts
const file = input.files[0];
const ticket = await client.axeda.image.upload({
  purpose: 'company.logo',
  targetId: companyId,
  contentType: file.type,
  size: file.size,
});
await fetch(ticket.data.url, {
  method: ticket.data.method,
  headers: ticket.data.headers,
  body: file,
});
const { data } = await client.axeda.image.complete({ uploadId: ticket.data.uploadId });
// data.url is now the company's logoUrl
```

- **Who can.** The logo or favicon of a company, business or site needs the same permission as editing it.
  A profile picture is changed by the person, or by someone with `axeda:user:manage` over them.
- **What is accepted.** PNG, JPEG and WebP, never SVG. The type is decided by the bytes of the file, not by
  what the browser declares. Up to 2 MiB and 4096 pixels per side (1024 for a favicon); with an
  `imageProcessor` a larger image is shrunk instead. A file that does not pass is deleted.
- **What is stored.** Each image under a random key (`images/<random>.png`), with no company or user in it,
  cached for a year. Setting a new one deletes the old one; purging or deleting the entity deletes its images;
  deleting a user deletes their picture.
- **Uploads in progress** live under `uploads/` for 10 minutes. `purgeDeleted()` removes the ones nobody
  completed. Block `/uploads/*` on your public domain and add a lifecycle rule (see the
  [storage package](https://github.com/teamblindmx/axeda/tree/main/packages/storage#setting-up-cloudflare-r2)).

### Adjusting the menu without deploying

The menu is still declared in code (`menus`), with the permission each option needs. On top of it, whoever
holds `axeda:menu:manage` can **hide** an item (and everything under it), **reorder** it among its siblings
or **rename** it, per language:

```ts
await client.axeda.menuAdjustment.set({
  level: { type: 'company', id: companyId }, // or { type: 'global' } for everyone
  itemKey: 'reports',
  label: { es: 'Análisis', en: 'Analytics' },
  order: 0,
});
await client.axeda.menuAdjustment.reset({
  level: { type: 'company', id: companyId },
  itemKey: 'reports',
});
```

- **Two levels.** Global adjustments (permission in global) apply to everyone; a company's (permission in that
  company) apply on top inside it, field by field. Businesses and sites use their company's menu.
- **Nothing new can be added.** Only items declared in code can be adjusted; their path and their permission
  never change, so an adjustment cannot add a link nor show an option to someone without its permission.
- Changes are audited (`menu.adjust`, `menu.reset`) and take effect on the next `GET /axeda/menu`.

### Features per company

Declare the modules your platform sells, and the permissions that depend on each one:

```ts
const axedaPlugin = axeda({
  permissions: ['inventory:read', 'inventory:write', 'invoice:read'],
  features: {
    inventory: { name: 'Inventory', permissions: ['inventory:*'] },
    reports: { name: 'Reports', permissions: ['invoice:read'], enabledByDefault: true },
  },
});
```

- **Off unless switched on.** A feature is off for every company unless `enabledByDefault` says otherwise.
  Only the platform switches it per company (`POST /axeda/feature/set`, with `axeda:feature:manage` in
  global): a company cannot switch on a module it did not pay for.
- **Its permissions do not count where it is off.** If a company does not have `inventory`, `inventory:*`
  does not count for anyone **inside that company**, whatever roles they hold, even `*`. `can()`,
  `scopeFilter()` and the menu follow. Global assignments (the platform) are not cut.
- **Administration never depends on a plan**: a feature cannot list an `axeda:` permission.
- `axeda.hasFeature(companyId, 'inventory')` answers on the server; `GET /axeda/feature/list?companyId=…`
  tells a front end which modules the company has.

### Staff accounts: username and PIN

Nothing to install: the plugin brings the endpoints and hashes PINs with Better Auth's password hashing and
a key derived from its `secret`. You decide who may create staff by giving `axeda:staff:manage`.

```ts
const axedaPlugin = axeda({
  permissions: ['order:create', 'order:read'],
  staff: { pinLength: 6, maxAttempts: 5, lockMinutes: 15 }, // the defaults
});
```

An administrator creates a staff member and hands over the PIN, which is shown only in this answer:

```ts
const { data } = await client.axeda.staff.create({
  scope: { type: 'business', id: businessId },
  username: 'waiter1',
  name: 'Ana López',
  roleIds: [waiterRoleId],
});
// data.pin, for example '381946'
```

On the terminal, the staff member signs in; the answer sets the session cookie as any other sign-in:

```ts
await fetch('https://api.acme.com/api/auth/axeda/staff/sign-in', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ company: 'acme', username: 'waiter1', pin: '381946' }),
});
```

- **Every failure looks the same**: `401 AXEDA_STAFF_SIGN_IN_FAILED`, whether the company or the username do not
  exist, the PIN is wrong, or the account is locked or suspended. Show one message.
- **Lock.** After `maxAttempts` wrong PINs in a row the account is locked for `lockMinutes`, even for the right
  PIN. An administrator can unlock it (`staff/unlock`) or reset the PIN (`staff/reset-pin`, which also closes
  its sessions). There is also a limit of 10 sign-ins a minute per address.
- **The PIN is not a Better Auth password**: it does not work on `/sign-in/email`, and "forgot my password" does
  not apply. A staff member changes it with `staff/change-pin`, giving the current one.
- **Weak PINs are refused** (`111111`, `123456`, `121212`…), both generated and chosen.
- **Shared terminals.** Sessions follow `maxSessionAge` like any other; on a shared device, sign out at the
  end of each shift.

### Session lifetime

Two limits apply, and the shorter one wins:

- Better Auth's `session.expiresIn` (7 days with the preset) is the **idle** time: it renews while the
  session is used.
- `maxSessionAge` (30 days by default) is the **absolute** time since sign-in. After it, the user signs
  in again, however recently they were active.

While the limit holds a session back, Better Auth writes the session row on every request during the
last `expiresIn` minus `updateAge` of its life (6 days with the preset), instead of once a day.

### Audit retention

The audit log only grows unless you set how long to keep it. With `retention.auditDays`, call
`purgeAudit()` on a schedule, as you do with `purgeDeleted()`; Axeda runs nothing in the background:

```ts
// For example once a day, from your cron or scheduler.
const axedaInstance = plugin.instance();
await axedaInstance.purgeDeleted();
await axedaInstance.purgeAudit(); // { removed, before }
```

- It deletes the events older than that many days, in batches and outside a transaction: if it stops halfway,
  the next call carries on.
- When it deletes something it records an `audit.purge` event, with the cut-off and how many it removed.
- Without `retention.auditDays` it throws `AXEDA_INVALID_CONFIG` instead of deleting anything.
- What the law or your auditors ask you to keep is yours to decide. If you must keep more than the database
  should hold, export the old events before purging them.

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
- [ ] `retention.auditDays` is set and `purgeAudit()` runs on a schedule, or you archive the audit log yourself.
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
