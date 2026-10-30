# Security

Report vulnerabilities privately: see [SECURITY.md](../../SECURITY.md). Do not open a public issue.

## What Axeda guarantees

Each of these has tests, and the riskiest ones were checked by breaking the rule on purpose to
confirm a test fails.

| Guarantee                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deny by default.** No assignment, no access. Unknown permissions are errors, not “no”                                                       |
| **Company isolation.** A role in one company never reaches another; the company of a business comes from the database, never from the request |
| **No escalation.** Nobody can grant, edit or ban their way above their own level                                                              |
| **Immediate revocation.** The next request after a revoke is denied, on every instance                                                        |
| **Authorize before revealing.** A refused request gets the same answer for a real id and an invented one                                      |
| **Bans are total.** A banned user cannot open sessions, loses open ones and holds no permission on any path                                   |
| **No password handling.** Axeda never sees, sets or stores a password                                                                         |
| **Responses by allow-list.** Every endpoint returns a declared shape; a column you add to `user` never leaks                                  |
| **Atomic where it matters.** Version checks, counters and one-shot closes use atomic database operations                                      |
| **Nothing is cached.** Every `/axeda/*` response, errors included, carries `Cache-Control: no-store`                                          |
| **Audit.** Administrative actions and denials are appended to a log                                                                           |
| **Fail closed.** A failure while checking a permission refuses the request; internal errors reach the client as a generic `500`               |

## What `secureAuthOptions()` sets

```ts
betterAuth({
  ...secureAuthOptions({ baseURL, secret, trustedOrigins }),
  database,
  plugins: [axedaPlugin],
});
```

| Setting                | Value                                              | Why                                                             |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `trustedOrigins`       | Explicit list, normalised                          | Decides which sites may call with a cookie and be redirected to |
| Cookies                | `HttpOnly`, `SameSite=Lax`, `Secure` in production | Scripts cannot read them; cross-site sends are limited          |
| Passwords              | 12 to 128 characters                               | Length beats composition rules                                  |
| Email verification     | Required                                           | Invitations rely on a verified email                            |
| Password reset         | Closes every session                               | A stolen session does not survive the reset                     |
| Sessions               | 7 days, refreshed daily, 15 minutes “fresh”        | Bounded exposure                                                |
| Session cookie cache   | Off                                                | A revoked session or permission would stay valid                |
| CSRF and origin checks | On                                                 | Axeda's endpoints authenticate with a cookie                    |
| Rate limits            | On; sign-in 5/min, sign-up 5/5 min, reset 3/5 min  | Slows guessing and abuse, per address                           |

It **refuses to return** a weak configuration: a secret under 32 characters or with fewer than 8
distinct characters, a wildcard origin, an origin with a path, `http` outside `localhost`, or
`requireEmailVerification: false` in production. The Axeda plugin in turn refuses to start if
`session.cookieCache`, `advanced.disableCSRFCheck`, `advanced.disableOriginCheck` or
`advanced.ipAddress.disableIpTracking` is on.

**Behind a reverse proxy,** pass `trustedProxies` (IPs or CIDR). Without it, Better Auth trusts
only a single-value `X-Forwarded-For`; a chain could be forged to dodge rate limits.

**Several instances?** The default rate-limit counter lives in memory, per process, so the real
limit multiplies by the number of instances. Use `rateLimitStorage: 'database'`.

**Sessions in `secondaryStorage` (Redis)?** Better Auth then keeps a copy of the user row next to
each session and refreshes it only when Better Auth itself changes the user. Axeda's changes
(a revoked assignment, a 2FA flag) would not reach that copy, so when `secondaryStorage` is set,
the plugin endpoints and `sessionPrincipal` re-read the user from the database: one extra query
per request, in exchange for revocations that take effect at once.

## Checklist before you go live

- [ ] `BETTER_AUTH_SECRET` is random, stored in a secret manager, not in the repository
- [ ] The site is served only over HTTPS; `baseURL` and every trusted origin are `https`
- [ ] `trustedOrigins` lists only your front ends
- [ ] CORS allows exactly those origins, with credentials — never `*`
- [ ] `trust proxy` (Express) and `trustedProxies` (Better Auth) match your real proxies
- [ ] Verification and invitation emails go through a real provider; links are not written to logs
- [ ] Your own routes have rate limits, a body size limit and security headers
- [ ] 2FA is enabled for accounts that hold administrative roles (below)
- [ ] The database has real transactions (SQLite, PostgreSQL); backups are tested
- [ ] `purgeDeleted()` runs on a schedule if you rely on deleted companies disappearing
- [ ] Someone watches the audit log

## Two-factor authentication for administrators

Mark sensitive roles `requireMfa: true`. Such a role grants nothing to a user without 2FA. Be
precise about what that means: Better Auth's session does **not** record whether this session
passed a second factor, only whether the user **has** 2FA enabled. And “trust this device” skips
the code. For administrative accounts, disable trusted devices in the `twoFactor` plugin.

## API keys

If you use Better Auth's `apiKey` plugin with sessions for keys, build the caller with
`await principalFromSession(ctx)` / `sessionPrincipal`, which carry the `banned` and 2FA flags. A banned
user holds no permission even through a key.

## Known limits

Stated plainly, so you can decide:

- **Databases.** Verified: SQLite and PostgreSQL (PostgreSQL through an in-process engine; tests
  against a real server with a connection pool are scheduled before the first release). MySQL and
  MongoDB are not supported yet.
- **One authority.** Axeda is the only source of permissions. Better Auth's own `admin` and `organization` plugins have roles of their own; Axeda ignores them, so do not check them in your routes or you will have two systems that can disagree.
- **Menus** are read-only and come from code; editing them through the API is planned.
- **Messages** from the API are in English; the codes (`AXEDA_*`) are stable and meant for you to
  translate.
- **Audit retention** is not automatic: the log only grows. Archive it on your side for now.
- **Pending invitations** have no cap per scope yet.
- **`user/list` with `banned`** filters after the query, so a page may hold fewer rows than the limit.
- **Real-server concurrency** (many parallel writers on one PostgreSQL) is covered by atomic
  operations in tests, but not yet stress-tested on a real server.
