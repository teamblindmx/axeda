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

`@axeda/express` adds `AXEDA_UNAUTHENTICATED` (401), `AXEDA_FORBIDDEN` (403), `AXEDA_NOT_FOUND`
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
