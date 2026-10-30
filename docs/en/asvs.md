# ASVS register

A self-assessment of Axeda against the [OWASP Application Security Verification Standard](https://owasp.org/www-project-application-security-verification-standard/) 5.0.0, aimed at **level 2**. It is not a certification: nobody outside the project has audited it.

ASVS verifies **applications**; Axeda is a library inside one. So every requirement is placed where it belongs: what Axeda itself guarantees (and the test that proves it), what Better Auth provides and the preset configures, and what stays with the application or its deployment. Requirement numbers are ASVS's; the wording here is a short paraphrase (ASVS is licensed CC BY-SA 4.0).

## How to read this

| Status             | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| **Met**            | Axeda does it, and a test or a check in the CI shows it.                         |
| **Partial**        | Axeda does part of it; what is left is stated.                                   |
| **Delegated**      | Better Auth (or Express) does it; the preset configures or refuses to weaken it. |
| **Yours**          | The application or its deployment must do it; the documentation says how.        |
| **Not applicable** | Axeda has no such feature.                                                       |
| **Gap**            | Not covered. Known, and stated.                                                  |

## Summary

| Status         | Rows |
| -------------- | ---: |
| Met            |   53 |
| Partial        |   17 |
| Delegated      |   12 |
| Yours          |   14 |
| Not applicable |   11 |
| Gap            |    1 |

## V8 Authorization

| ASVS   | Level | Status         | How                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | :---: | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V8.1.1 |   1   | Met            | The rules are written down: [Concepts](concepts.md) and the permission each endpoint requires in the [reference](reference.md).                                                                                                                                                                                                                                                    |
| V8.1.2 |   2   | Yours          | Axeda authorizes functions and scopes, not individual fields. Field-level rules for your data are yours; Axeda's own responses are fixed allow-lists.                                                                                                                                                                                                                              |
| V8.1.3 |   3   | Met            | Axeda decides from identity, scope, role status, expiry dates, a ban and whether 2FA is enabled. It uses no location, device or time of day. Documented in [Concepts](concepts.md).                                                                                                                                                                                                |
| V8.1.4 |   3   | Met            | Same as V8.1.3: the only contextual factors are the ones listed there.                                                                                                                                                                                                                                                                                                             |
| V8.2.1 |   1   | Met            | Every endpoint requires a session and a permission declared in its metadata; a test walks all of them (`plugin-http.test.ts`). `requirePermission()` denies by default.                                                                                                                                                                                                            |
| V8.2.2 |   1   | Met            | Axeda's own objects are never reached by id alone: the scope is resolved on the server and a refused request answers the same for a real and an invented id (`enumeration.test.ts`, 24 operations, including a company administrator probing another company). For your own resources, check ownership as in pattern 4 of [Protecting routes](express.md); the example has a test. |
| V8.2.3 |   2   | Partial        | Request bodies are strict (unknown fields are refused, so no mass assignment) and responses are allow-lists. Field-level permissions for your data are yours.                                                                                                                                                                                                                      |
| V8.2.4 |   3   | Not applicable | Axeda makes no decisions from location or device. It only rate-limits.                                                                                                                                                                                                                                                                                                             |
| V8.3.1 |   1   | Met            | Authorization is enforced in the server library; a menu is only a convenience and says so.                                                                                                                                                                                                                                                                                         |
| V8.3.2 |   3   | Met            | A version-validated cache: a revoke applies on the next request on every instance (`cache-and-queries.test.ts`, `concurrency.test.ts`). A ban closes sessions at once.                                                                                                                                                                                                             |
| V8.3.3 |   3   | Met            | Every operation uses the permissions of the person who calls (a `Principal` built from the session); nothing runs under a service identity. A banned principal holds nothing, on any path (`banned-reads.test.ts`).                                                                                                                                                                |
| V8.4.1 |   2   | Met            | Company isolation: the company of a business is read from the database, and no one can grant, edit or ban their way past their own level (`escalation.property.test.ts`, `tenants-http.test.ts`).                                                                                                                                                                                  |
| V8.4.2 |   3   | Partial        | Administrative actions need `axeda:*` permissions and, for roles marked `requireMfa`, 2FA enabled. Axeda does not assess device posture or ask for a recently authenticated session. This one is level 3.                                                                                                                                                                          |

## V2 Validation and business logic

| ASVS   | Level | Status         | How                                                                                                                                                                                    |
| ------ | :---: | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2.1.1 |   1   | Partial        | Every input is a strict schema and the limits are in the [reference](reference.md); there is no machine-readable description (OpenAPI) yet.                                            |
| V2.1.2 |   2   | Not applicable | Axeda has no combined-field rules beyond the checks listed in V2.2.3.                                                                                                                  |
| V2.1.3 |   2   | Met            | Limits are documented and configurable: assignments per user, permissions per role, roles per invitation, menu size, page size.                                                        |
| V2.2.1 |   1   | Met            | Strict allow-list schemas (`zod`) for every body and query: permission syntax, slugs, menu paths, scope and expiry are validated and unknown fields refused (`hardening.test.ts`).     |
| V2.2.2 |   1   | Met            | Validation runs in the server library; nothing relies on the client.                                                                                                                   |
| V2.2.3 |   2   | Met            | Related values are checked together: a business must belong to the company in the path, a role's permissions must be valid at the level of the scope, an expiry must be in the future. |
| V2.3.1 |   1   | Met            | Invitations close atomically (create, then accept once) and `bootstrap` works once, both tested under concurrent callers (`concurrency.test.ts`).                                      |
| V2.3.2 |   2   | Met            | The limits are enforced and tested, including against concurrent writers.                                                                                                              |
| V2.3.3 |   2   | Met            | Every administrative write is one transaction together with its audit record, and Axeda refuses to start on a database without real transactions.                                      |
| V2.3.4 |   2   | Met            | Atomic guards (`incrementOne`, unique indexes) protect versions, limits and one-time closes; tested with parallel writers against PostgreSQL 16 and 18 in the CI.                      |
| V2.4.1 |   2   | Partial        | Rate limits on Axeda's endpoints (120 per minute, 30 on the public one) and, through the preset, on sign-in, sign-up and password reset. Your own routes are yours.                    |

## V4 API and web service

| ASVS             | Level | Status         | How                                                                                                                                             |
| ---------------- | :---: | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| V4.1.1           |   1   | Delegated      | Responses are JSON with the right `Content-Type`, produced by Better Auth and Express.                                                          |
| V4.1.2           |   2   | Yours          | Redirecting HTTP to HTTPS is a deployment matter. The preset refuses non-HTTPS URLs in production.                                              |
| V4.1.3           |   2   | Partial        | Proxies: `trustedProxies` in the preset and Express `trust proxy`. Without them a forged `X-Forwarded-For` chain is ignored (`preset.test.ts`). |
| V4.2.1           |   2   | Yours          | How a request's boundaries are determined is decided by your servers and proxies.                                                               |
| V4.3.1 to V4.4.4 |   2   | Not applicable | Axeda has no GraphQL and no WebSocket.                                                                                                          |

## V6 Authentication

| ASVS              | Level | Status    | How                                                                                                                                                                                                 |
| ----------------- | :---: | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V6.1.1            |   1   | Partial   | The preset enables documented rate limits (sign-in 5 per minute, sign-up 5 per 5 minutes, reset 3 per 5 minutes); see [Security](security.md).                                                      |
| V6.2.1            |   1   | Delegated | Better Auth. The preset requires 12 to 128 characters.                                                                                                                                              |
| V6.2.2 and V6.2.3 |   1   | Delegated | Better Auth: changing a password requires the current one.                                                                                                                                          |
| V6.2.4            |   1   | Yours     | Not in the preset. Enable Better Auth's `haveIBeenPwned` plugin, or an equivalent check.                                                                                                            |
| V6.3.1            |   1   | Delegated | Better Auth with the preset's limits; tested: the sixth sign-in attempt from an address is refused (`preset.test.ts`).                                                                              |
| V6.4.1            |   1   | Met       | Axeda creates accounts with no credential at all, so there is no initial password; the person sets one through the normal Better Auth flow.                                                         |
| V6.5.1 to V6.5.5  |   2   | Met       | Invitation secrets (the only codes Axeda issues): single use, 256 bits from a CSPRNG, stored only as a SHA-256 hash, with a limited lifetime (72 hours by default) (`invitations-service.test.ts`). |
| V6 (rest)         |   —   | Delegated | Everything else about credentials, second factors and federated identity belongs to Better Auth and its plugins; review its documentation and your configuration.                                   |

## V7 Session management

| ASVS              | Level | Status    | How                                                                                                                                                                                                                              |
| ----------------- | :---: | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V7.1.1            |   2   | Met       | Lifetimes are documented: 7 days, refreshed daily, 15 minutes "fresh" ([Security](security.md)).                                                                                                                                 |
| V7.1.2            |   2   | Yours     | Better Auth allows any number of concurrent sessions; limit them if you need to.                                                                                                                                                 |
| V7.2.1            |   1   | Met       | Every check asks Better Auth on the server. Axeda refuses to start with the session cookie cache on, so a revoked session cannot linger (`plugin-http.test.ts`).                                                                 |
| V7.2.2 to V7.2.4  |   1   | Delegated | Better Auth generates random reference tokens with a CSPRNG and issues a new one at every sign-in.                                                                                                                               |
| V7.3.1 and V7.3.2 |   2   | Partial   | Sessions expire after 7 days and are renewed on use. There is no separate absolute maximum, so a session in daily use never expires on its own.                                                                                  |
| V7.4.1            |   1   | Met       | A terminated session is refused on the next request (no cache; see V7.2.1).                                                                                                                                                      |
| V7.4.2            |   1   | Met       | A ban closes every open session and blocks new ones (`users-http.test.ts`); deleting a user removes its sessions in Better Auth.                                                                                                 |
| V7.4.3            |   2   | Delegated | The preset closes every session when a password is reset; changing a password can also revoke the other sessions (Better Auth).                                                                                                  |
| V7.4.4            |   2   | Yours     | A sign-out control is part of your front end.                                                                                                                                                                                    |
| V7.4.5            |   2   | Met       | `POST /axeda/user/revoke-sessions` signs a person out everywhere, with `axeda:user:manage` and without touching someone more powerful (`users-service.test.ts`).                                                                 |
| V7.5.1            |   2   | Delegated | This is about changing what authenticates a person (email, phone, second factor). Axeda changes none of those; Better Auth does, and asks for a fresh session on its sensitive endpoints (`freshAge`, 15 minutes in the preset). |
| V7.5.2            |   2   | Delegated | Better Auth lists and revokes a person's own sessions.                                                                                                                                                                           |
| V7.6.1 and V7.6.2 |   2   | Delegated | Better Auth and its identity providers.                                                                                                                                                                                          |

## V11 Cryptography

| ASVS                                                                     | Level | Status         | How                                                                                                                                                                           |
| ------------------------------------------------------------------------ | :---: | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V11.2.1                                                                  |   2   | Met            | Only the platform's standard implementations are used (`crypto.getRandomValues`, `crypto.subtle`); there is no custom cryptography.                                           |
| V11.2.3                                                                  |   2   | Met            | A 256-bit secret hashed with SHA-256: more than 128 bits of security.                                                                                                         |
| V11.4.1                                                                  |   1   | Met            | SHA-256 is the only hash Axeda uses.                                                                                                                                          |
| V11.4.2                                                                  |   2   | Delegated      | Axeda never handles passwords. Better Auth hashes them with scrypt.                                                                                                           |
| V11.5.1                                                                  |   2   | Met            | Every non-guessable value Axeda creates (invitation secrets) comes from a CSPRNG; comparisons of secrets run in constant time. No `Math.random` anywhere in the shipped code. |
| V11.1.1, V11.1.2, V11.2.2, V11.3.1 to V11.3.3, V11.4.3, V11.4.4, V11.6.1 |   1   | Not applicable | Axeda encrypts nothing, signs nothing and derives no keys; the cryptography it uses is the one listed above.                                                                  |

## V13 Configuration

| ASVS                | Level | Status         | How                                                                                                                                                 |
| ------------------- | :---: | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| V13.1.1             |   2   | Met            | Axeda makes no outbound connections. Its one external effect is your `invitationDelivery.send` callback.                                            |
| V13.2.1 and V13.2.2 |   2   | Yours          | The connection to your database is configured by you: use credentials of your own and TLS.                                                          |
| V13.2.3             |   2   | Met            | There are no default credentials: the secret and the URLs have no defaults, and the preset refuses a short or repetitive secret (`preset.test.ts`). |
| V13.2.4 and V13.2.5 |   2   | Not applicable | Axeda sends requests to no external resource.                                                                                                       |
| V13.3.1 and V13.3.2 |   2   | Yours          | Keep `BETTER_AUTH_SECRET` and the database credentials in a secrets manager (the checklist is in [Security](security.md)).                          |
| V13.4.1             |   1   | Met            | The published packages contain only `dist` and the legal files; `pack:check` fails if sources, `.git` or `.env` would ship.                         |
| V13.4.2             |   2   | Partial        | Axeda has no debug mode and returns generic errors; do not enable verbose logging of Better Auth in production.                                     |
| V13.4.3 to V13.4.5  |   2   | Yours          | Directory listings, the TRACE method and exposed documentation or monitoring endpoints are decided by your web server.                              |

## V14 Data protection

| ASVS    | Level | Status         | How                                                                                                                                                                                                                                                  |
| ------- | :---: | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V14.1.1 |   2   | Met            | Classified in [Data Axeda stores](#data-axeda-stores) below.                                                                                                                                                                                         |
| V14.1.2 |   2   | Partial        | Protections are listed below. There is no automatic retention for the audit log, which only grows; archive it on your side.                                                                                                                          |
| V14.2.1 |   1   | Partial        | Axeda's API sends nothing sensitive in a URL. The invitation link carries its secret in the query string by design, like a password-reset link: it is single use, expires and is hashed at rest, so send it only over HTTPS and keep it out of logs. |
| V14.2.2 |   2   | Met            | `Cache-Control: no-store` on every Axeda response; the permission cache is in each process's memory, bounded to 10,000 users and validated against the database on every use.                                                                        |
| V14.2.3 |   2   | Yours          | Axeda sends nothing to third parties; what your front end sends is yours.                                                                                                                                                                            |
| V14.2.4 |   2   | Partial        | Audit metadata never holds secrets and is capped at 2 KB; retention is not automated (see V14.1.2).                                                                                                                                                  |
| V14.3.1 |   1   | Not applicable | Axeda has no user interface and its client plugin stores nothing.                                                                                                                                                                                    |
| V14.3.2 |   2   | Met            | `Cache-Control: no-store` on every `/axeda/*` response, errors included (`hardening.test.ts`), and on every denial of `@teamblind/axeda-express`.                                                                                                    |
| V14.3.3 |   2   | Met            | Nothing in browser storage; the only cookies are Better Auth's, `HttpOnly`.                                                                                                                                                                          |

## V15 Secure coding and architecture

| ASVS    | Level | Status         | How                                                                                                                                                         |
| ------- | :---: | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V15.1.1 |   1   | Met            | Remediation targets (7 days for high and critical, 30 for moderate) are in `SECURITY.md`.                                                                   |
| V15.1.2 |   2   | Met            | `npm run sbom` writes a CycloneDX inventory per package and the CI keeps it. The published packages have one third-party dependency, `zod`.                 |
| V15.1.3 |   2   | Partial        | Costly work is bounded: pages of at most 100, a cache of at most 10,000 users, limits per user and per role. `purgeDeleted()` is meant for a scheduled job. |
| V15.2.1 |   1   | Met            | `npm audit` runs on every pull request and every week, with a check of registry signatures and provenance; no known vulnerabilities at the time of writing. |
| V15.2.2 |   2   | Partial        | Rate limits, page caps and a bounded cache; there is no per-request time budget.                                                                            |
| V15.2.3 |   2   | Met            | Off unless configured: the public identity endpoint, invitations and user administration. The tarballs hold only `dist`.                                    |
| V15.3.1 |   1   | Met            | Responses are fixed allow-lists; a test checks that no user response contains `password`, `token`, `hash` or `secret` (`users-http.test.ts`).               |
| V15.3.2 |   2   | Not applicable | Axeda makes no outbound HTTP requests.                                                                                                                      |
| V15.3.3 |   2   | Met            | Strict schemas refuse unknown fields and every response copies fields one by one.                                                                           |
| V15.3.4 |   2   | Partial        | `trustedProxies` in the preset and `trust proxy` in Express; the address reaches the audit log. Configuring them is yours.                                  |
| V15.3.5 |   2   | Met            | TypeScript in strict mode, ESLint `eqeqeq` and `zod` parsing at every boundary.                                                                             |
| V15.3.6 |   2   | Met            | Unknown keys, `__proto__` and `constructor` included, are refused with 400 and `Object.prototype` stays untouched (`hardening.test.ts`).                    |
| V15.3.7 |   2   | Met            | Repeated or array parameters are refused with 400 (`hardening.test.ts`); `@teamblind/axeda-express` rejects them too (`express.test.ts`).                   |

## V16 Security logging and error handling

| ASVS                | Level | Status  | How                                                                                                                                                                                                                                                       |
| ------------------- | :---: | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V16.1.1             |   2   | Partial | The audit log is Axeda's record of what happens and is documented. Axeda writes no application logs: unexpected errors go to your error handler.                                                                                                          |
| V16.2.1             |   2   | Met     | Each audit event records when, who (actor), what (action), on what (target and scope), the outcome, the address and the user agent.                                                                                                                       |
| V16.2.2             |   2   | Met     | Timestamps are UTC and ids are ordered chronologically.                                                                                                                                                                                                   |
| V16.2.3 and V16.2.4 |   2   | Yours   | Where logs go and in what format is decided by your logging stack.                                                                                                                                                                                        |
| V16.2.5             |   2   | Met     | Secrets never reach the audit log and the metadata is capped at 2 KB.                                                                                                                                                                                     |
| V16.3.1             |   2   | Gap     | Better Auth keeps no authentication log and Axeda audits authorization, not sign-ins. Record them with Better Auth hooks.                                                                                                                                 |
| V16.3.2             |   2   | Met     | Denied administrative attempts are audited, outside the transaction that was rolled back (`assignments-service.test.ts`, `roles-service.test.ts`).                                                                                                        |
| V16.3.3             |   2   | Met     | Bans, grants, revocations, role edits, bootstrap and denials are audited. `@teamblind/axeda-express` reports every route it refuses, cross-site writes included, to your `onDenied` hook with the exact reason (`denied.test.ts`); what you log is yours. |
| V16.3.4             |   2   | Partial | Unexpected errors become a generic 500 and reach your error handler; logging them is yours.                                                                                                                                                               |
| V16.4.1             |   2   | Met     | Audit events are structured data, not concatenated text.                                                                                                                                                                                                  |
| V16.4.2             |   2   | Partial | The library offers no way to edit or delete audit events (the store has no such operation); protect the table with database permissions.                                                                                                                  |
| V16.4.3             |   2   | Yours   | Shipping logs to a separate system is yours.                                                                                                                                                                                                              |
| V16.5.1             |   2   | Met     | Anything unexpected becomes `AXEDA_INTERNAL_ERROR` with a generic message; configuration and data errors are never detailed to a client.                                                                                                                  |
| V16.5.2             |   2   | Met     | A failing delivery is reported (`AXEDA_DELIVERY_FAILED`) after the data is committed and can be sent again; Axeda refuses to start without real transactions.                                                                                             |
| V16.5.3             |   2   | Met     | Fail closed: `@teamblind/axeda-express` never runs the route when a lookup fails (`express.test.ts`).                                                                                                                                                     |

## The other chapters

| ASVS | Level | Status         | How                                                                                                   |
| ---- | :---: | -------------- | ----------------------------------------------------------------------------------------------------- |
| V1   |   —   | Yours          | Axeda answers only JSON; escape what you display. `invitationDelivery.send` receives data, not HTML.  |
| V3   |   —   | Not applicable | Axeda has no web front end.                                                                           |
| V5   |   —   | Not applicable | No files are handled; logos are URLs.                                                                 |
| V9   |   —   | Not applicable | Axeda issues and accepts no self-contained tokens (no JWT).                                           |
| V10  |   —   | Delegated      | OAuth and OpenID Connect, if you use them, are Better Auth's.                                         |
| V12  |   —   | Yours          | TLS is terminated by you; the preset refuses non-HTTPS URLs in production and makes cookies `Secure`. |
| V17  |   —   | Not applicable | No WebRTC.                                                                                            |

Chapters not listed individually apply to the application, not to the library.

## Data Axeda stores

What Axeda keeps, where it can be read from and how it is protected (V14.1).

| Data                     | What it holds                                                                                                             | Protection                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Assignments              | User id, role id, scope, who granted it, expiry date.                                                                     | Readable only with `axeda:assignment:manage` in that scope, or by the person themself.                                   |
| Audit events             | Actor, action, target, scope, outcome, address (64 characters at most), user agent (255) and metadata (2 KB, no secrets). | Append-only in the library; readable with `axeda:audit:read`; `no-store` responses.                                      |
| Invitations              | Email, scope, role ids, inviter, expiry, and the SHA-256 hash of the secret (never the secret).                           | Lists never return the hash; the secret is 256 bits, single use, and accepted only by the verified owner of the email.   |
| User fields              | Added to Better Auth's user: `authzVersion`, `banned`, `banReason`, `banExpires`.                                         | Responses copy a fixed list of fields (id, email, name, `emailVerified`, `twoFactorEnabled`, ban fields, creation date). |
| Companies and businesses | Name, slug, logo and favicon URLs, a free `metadata` object (yours).                                                      | Visible to members and platform administrators; deleted records are kept only for the grace period.                      |

## Known gaps

Everything marked Gap or Partial above, in one place, so none of it is a surprise:

- Axeda's administrative endpoints do not require a recently authenticated session, and device posture is not assessed (V8.4.2, a level 3 requirement).
- Better Auth records no authentication log, and Axeda audits authorization only (V16.3.1).
- There is no absolute maximum session lifetime; a session in daily use never expires on its own (V7.3).
- The audit log has no automatic retention and relies on database permissions to stay unmodified (V14.1.2, V16.4.2).
- Common-password checks are not in the preset (V6.2.4).
- There is no machine-readable API description yet (V2.1.1).
