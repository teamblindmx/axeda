# @teamblind/axeda-core

## 0.1.0-alpha.4

### Minor Changes

- 16d834d: Audit retention: set `retention.auditDays` and call `purgeAudit()` on a schedule (like `purgeDeleted()`) to delete the audit events older than that many days. Without the option the audit log is kept in full, as before, and `purgeAudit()` throws `AXEDA_INVALID_CONFIG` instead of deleting anything.

  - It deletes in batches of 500 by primary key, outside a transaction, so a large backlog never holds a long lock and an interrupted run simply continues next time. No new index or migration is needed.
  - A run that deletes something records an `audit.purge` event (system actor) with the cut-off and the count.
  - `AuditStore` gains `deleteBefore(before, limit)`, checked by `runPersistenceContract`; `auditIdFloor` is exported for stores that key events by Axeda's audit ids.

- c26c30e: Add features per company: the modules a platform sells, switched on per company by the platform.

  - `axeda({ features: { inventory: { permissions: ['inventory:*'] } } })` declares each feature and the permissions that depend on it (never Axeda ones). A feature is off unless `enabledByDefault`.
  - Where a company does not have a feature, its permissions do not count for anyone inside that company, whatever their roles (even `*`): `can`, `effectivePermissions`, `scopesFor`, `scopeFilter`, the menu and the no-escalation check follow. Global assignments are not cut.
  - `axeda.hasFeature(companyId, feature)`, `axeda.features.list` / `set` and the endpoints `GET /axeda/feature/list` and `POST /axeda/feature/set`; switching needs the new global permission `axeda:feature:manage`, is audited (`feature.set`) and takes effect on the next check.
  - `/axeda/me` with a place now lists the concrete permissions of the catalog that count there, sorted, instead of the raw keys (a wildcard with exceptions would not tell the truth). `PermissionSet` gains `concrete(catalog)`.
  - A `features` store in `AxedaPersistence` (Better Auth table `axedaCompanyFeature`), checked by `runPersistenceContract`. With features declared, a cold permission read makes one more query.

- ea22d5a: Adjust the menu through the API without deploying: hide an item (with everything under it), reorder it among its siblings or rename it per language, for everyone (global) or inside one company, whose businesses and sites inherit it.

  - New permission `axeda:menu:manage` (global or company), `axeda.menuAdjustments.list` / `set` / `reset` and the endpoints `/axeda/menu-adjustment/{list,set,reset}` (typed client: `client.axeda.menuAdjustment.*`).
  - Only items declared in code can be adjusted; their path and permission never change, so an adjustment can neither add a link nor show an option to someone without its permission. Company adjustments win over global ones field by field.
  - Changes are audited (`menu.adjust`, `menu.reset`); purging a company deletes its adjustments. `applyMenuAdjustments` is exported for custom menus.
  - A `menuAdjustments` store in `AxedaPersistence` (Better Auth table `axedaMenuAdjustment`), checked by `runPersistenceContract`.

- 8f974cf: Add staff accounts: people who sign in with a username and a PIN, created by an administrator (waiters, cooks…), for businesses that work with shared terminals.

  - New permission `axeda:staff:manage`, valid in a company, a business or a site. With it, `axeda.staff` creates staff there or below with a random PIN of 6 to 8 digits returned once, lists them by place, renames them, resets the PIN (closing their sessions), unlocks, suspends, reactivates and removes them. Staff change their own PIN by giving the current one.
  - Usernames are unique within a company; signing in takes the company slug, the username and the PIN. `axeda.staff.signIn` answers the same `AXEDA_STAFF_SIGN_IN_FAILED` (401) for every failure, hashes even when there is no account, and locks an account after 5 wrong PINs for 15 minutes (`options.staff`); simultaneous attempts never go past the limit.
  - A staff account never administers Axeda: a role with any Axeda permission (or `*`) cannot be given to it, and its effective permissions drop them even if a role is edited later.
  - The PIN is not a password of the identity system: it lives in Axeda's own store, hashed with the new `pinHasher` dependency. Purging or deleting a company, business or site for good also removes its staff and their users.
  - New: `options.staff`, `UserAdmin.delete`, error codes `AXEDA_USERNAME_TAKEN`, `AXEDA_STAFF_NOT_FOUND` and `AXEDA_STAFF_SIGN_IN_FAILED`, audit actions `staff.*`, a `staff` store in `AxedaPersistence` (Better Auth table `axedaStaff`) checked by `runPersistenceContract`, and `createTestPinHasher()` in `@teamblind/axeda-testing`.

- a9f5bde: Misspelled options are an error instead of being silently ignored. `axeda()` (and its `invitationDelivery`), `secureAuthOptions()`, `securePhoneNumberOptions()`, `createAxedaExpress()`, `requirePermission()`, `resolveScope()`, `s3Storage()` and `sharpImageProcessor()` throw `AXEDA_INVALID_CONFIG` for an option nobody reads, naming the one it probably meant (`unknown option "publicIdentiy". Did you mean "publicIdentity"?`). A misspelled `requirePermission` scope or `resolveScope` source used to check the permission in global instead of in the route. The core exports `rejectUnknownOptions` for your own helpers.

  **Check before upgrading:** if your application passed an option that does not exist, it now fails at startup with that message.

### Patch Changes

- fde7b4b: Security review of staff accounts:

  - **Resetting a PIN no longer lets a manager take over someone with more permissions.** A new PIN means signing in as that person, so `staff/reset-pin` now also requires the actor to hold every permission the account holds, wherever it holds it (`403`, reason `exceeds_granter_permissions`, with the missing permissions).
  - **Each lock in a row lasts twice as long** (15 minutes, 30, 1 hour…, up to a day) until the right PIN gets in, so slow PIN guessing no longer gets 5 tries every 15 minutes forever. Staff accounts gain `lockCount`; `AttemptPolicy` gains `maxLockMs` and `lockDuration` is exported for custom stores.
  - **The audit log records the client address behind trusted proxies.** Axeda now reads it with Better Auth's own `advanced.ipAddress` options (`trustedProxies`, `ipAddressHeaders`), as its rate limiter does, instead of ignoring them.

## 0.1.0-alpha.3

### Minor Changes

- 94bb097: Add images: logos and favicons of companies, businesses and sites, and profile pictures, uploaded straight from the browser to an object storage (Cloudflare R2, S3, MinIO…) with a signed URL.

  - `axeda.images.createUpload(actor, { purpose, targetId, contentType, size })` checks the same permission as editing that entity (or, for `user.avatar`, that it is the person or a user administrator), accepts only PNG, JPEG and WebP up to 2 MiB, and returns a signed PUT URL valid 10 minutes. `completeUpload(actor, uploadId)` reads the file with a byte cap, decides its type by its bytes (never by what was declared), checks its dimensions (4096 px per side, 1024 for a favicon), re-encodes it if an `imageProcessor` is configured, stores it under a random key and puts its public URL on the entity, deleting the previous image. `remove` takes it away. All of it is audited (`image.set`, `image.remove`).
  - New dependencies of `createAxeda`: `storage` (an `ObjectStorage`) and the optional `imageProcessor`. Without `storage`, images answer `AXEDA_FEATURE_DISABLED`. New options under `images` for the limits. New error codes `AXEDA_IMAGE_INVALID` and `AXEDA_UPLOAD_INVALID` (400).
  - `purgeDeleted()` also deletes the images of what it purges and the uploads nobody completed, and returns `images`. Deleting a company, business or site with `immediate` deletes its images too.
  - `ManagedUser` has `image`. `UserAdmin.setImage` is optional; without it there are no profile pictures.
  - Better Auth's migration creates the table `axedaImage`.
  - If you wrote your own persistence, `AxedaPersistence` needs an `images` store (`ImageStore`); `runPersistenceContract` checks it. `@teamblind/axeda-testing` adds `createMemoryStorage()`.

- ee80196: Images over HTTP and in the Better Auth plugin.

  - `axeda({ storage, imageProcessor, images })` passes the object storage (for example `s3Storage()` of `@teamblind/axeda-storage`), the optional processor and the image limits to the core.
  - New endpoints `POST /axeda/image/upload` (returns the signed PUT for the browser: `uploadId`, `url`, `method`, `headers`, `expiresAt`), `POST /axeda/image/complete` and `POST /axeda/image/remove`, with the typed client (`client.axeda.image.*`). Without `storage` they answer `AXEDA_FEATURE_DISABLED` (501).
  - Profile pictures are written to Better Auth's `user.image`, and `/axeda/user/*` returns `image`. Deleting a user through Better Auth deletes their picture.
  - `IMAGE_CONTENT_TYPES` is a closed list (`ImageContentType`), so the client refuses an unsupported type at compile time.

## 0.1.0-alpha.2

### Minor Changes

- 71ae834: Add access by phone number, and invitations by phone.

  - `securePhoneNumberOptions({ sendOTP })` returns safe options for Better Auth's `phoneNumber` plugin: 6-digit codes valid 5 minutes with 3 attempts, E.164 numbers only, sign-up on verification with a placeholder email (`…@phone.invalid`, recognised by `isPhoneOnlyEmail`), and a cap on the codes sent to one number per window (5 per hour by default) that holds whatever the address asking and across instances. `secureAuthOptions` adds rate limits for the phone routes.
  - `axeda.invitations.create` and `POST /axeda/invitation/create` take exactly one of `email` or `phoneNumber`. A phone invitation is accepted only by an account whose verified phone number is the invited one. Invitations carry `channel` and `phoneNumber`, and `invitationDelivery.send` receives them.
  - Users carry `phoneNumber` and `phoneNumberVerified` (`null` and `false` without access by phone), in the core, the directory, user administration and `/axeda/user/*`.
  - Better Auth's migration creates the table `axedaThrottle` and adds the optional column `channel` to `axedaInvitation`; existing invitations stay invitations by email.
  - If you wrote your own persistence, invitations have a `channel` and `findPending` looks up by contact (`invitationContact`); a custom `UserAdmin` must return the two phone fields. `runPersistenceContract` checks the stores.

- 6a6f3a0: Add sites: a fourth scope under the company. A site always belongs to a company and, optionally, to one of its businesses, so a company can have sites without businesses. A company assignment applies to all its sites, a business assignment to the sites of that business, and a site assignment only to that site. An inactive or deleted company or business blocks its sites, and purging a business or a company purges its sites. The employees of a site are the people with a role assigned in it.

  - Sites are managed with the new permission `axeda:site:manage`, from the company or from the business they hang from, through `axeda.sites` and the endpoints `/axeda/site/{list,get,create,update,set-status,delete,restore}`. A site that is not visible answers `AXEDA_SITE_NOT_FOUND` (404).
  - Assignments, invitations, the menu and the audit log accept the scope `{ type: 'site', id }`. `scopeFilter` returns `siteIds`, `purgeDeleted()` returns `sites`, and `axeda:assignment:manage` and `axeda:invitation:manage` are valid in a site.
  - `GET /axeda/me` takes an optional place (`?scopeType=site&scopeId=…`, also a company or a business) and then returns `permissions`: what the caller may do there, for a front end. Without it the answer is the same as before.
  - Express: `resolveScope({ site: 'siteId' })`, also with the company and the business in the URL, which must match the database.
  - Better Auth's migration creates the new table `axedaSite`.
  - If you wrote your own persistence (instead of the Better Auth or the memory one), `AxedaPersistence` now needs a `sites` store, and purging a company or a business must purge its sites; `runPersistenceContract` checks it.

## 0.1.0-alpha.1

### Patch Changes

- ce83aff: Shorten the ids of audit events from 50 to 36 characters so they fit the `id` column Better Auth creates on MySQL (`varchar(36)`); on SQLite and PostgreSQL the length was never a problem, which is why it went unnoticed. They still sort by time as text, also within one millisecond or when the clock goes back, and carry 88 random bits against collisions between processes. Events already stored keep their ids and keep their place in the order.

## 0.1.0-alpha.0

### Minor Changes

- b519956: Add the authorization use cases. `@teamblind/axeda-core` gains role management, assignments with the no-escalation rule (also on revoke and on role edits), an append-only audit log, `bootstrap` for the first administrator, roles declared in code that sync at start, `scopesFor` and `scopeFilter`, and a version-validated permission cache. `requireMfa` is now enforced when deciding. `@teamblind/axeda-better-auth` stores the audit log and exposes `createBetterAuthUserDirectory`; `@teamblind/axeda-testing` adds an in-memory user directory and covers the new ports in the contract suite.

  The Better Auth plugin now exposes the use cases as `/axeda/*` endpoints (every one requires a session and declares its permission), connects the session to the actor, cleans up on user deletion, refuses to start with `session.cookieCache`, and ships a typed client at `@teamblind/axeda-better-auth/client`. `npm run demo` runs the whole story against a real server.

- c55b0f4: Persist Axeda on top of the Better Auth database adapter. `@teamblind/axeda-better-auth` adds the plugin schema (roles, assignments, policy state and the user's `authzVersion`) and `createBetterAuthPersistence`, which implements the persistence ports for any database Better Auth supports, with atomic counters, optimistic role updates and real transactions. The persistence contract suite now also covers concurrent duplicate creation, and `@teamblind/axeda-core` adds the `AXEDA_USER_NOT_FOUND` and `AXEDA_DATA_CORRUPT` error codes.
- c6a80da: Add companies, businesses, invitations and public identity. Companies and businesses are real entities with versions, soft deletion with a grace period (and immediate deletion for privacy requests) and a status that silences their people at once; business scopes are now resolved from the database, never from the request. Invitations are single-use, only the owner of the verified email can accept them, and the inviter's current power is re-checked on acceptance. The plugin exposes `/axeda/company/*`, `/axeda/business/*`, `/axeda/invitation/*` and an opt-in `/axeda/public/identity`; the HTTP status of every error code is now decided exhaustively.
- a836007: Add the authorization core: permission keys with wildcards, scope inheritance (global → company → business), effective permissions, the no-escalation grant rule, persistence ports, option validation and `createAxeda` with a startup transaction check. `@teamblind/axeda-testing` adds an in-memory persistence with real transactions and a persistence contract suite.
- 7ebf1fd: Add Express middleware, a secure Better Auth preset and the first documentation. `@teamblind/axeda-express` provides `requireAuth()`, `requirePermission()` and `resolveScope()`: it denies by default, resolves the company of a business from the database, answers the same whether a scope exists or not, requires a trusted origin for cookie-bearing writes and never fails open. `@teamblind/axeda-better-auth` adds `secureAuthOptions()` (refuses weak secrets, wildcard or plain-http origins), `sessionPrincipal()` and `principalFromUser()`, and the plugin now refuses to start with Better Auth's CSRF check, origin check or IP tracking disabled. `@teamblind/axeda-core` adds `resolveTarget()` so applications never trust a company id sent by the client. Documentation in English and Spanish, and an example API in `apps/example`.
- b402e20: Add user administration and menus. Platform administrators can list users, create accounts without any credential, ban and unban (with an optional end date) and sign people out everywhere; a user with more administrative power than the actor cannot be touched, a ban applies to every path including API keys, and a banned account cannot open sessions. Menus are declared in code, validated at startup (every entry needs its permission, no cycles, safe paths) and `GET /axeda/menu` returns only what the person may use in the requested scope, in their language.

### Patch Changes

- fed4ed1: Make the packages publishable: compiled ES modules with type declarations under `dist/`, an `exports` map, `files` limited to what is needed, a README, the licence and the notice in each tarball, and the dependencies each package really uses (`@teamblind/axeda-core` for the others, `zod`, and `vitest` and `@types/express` as peers where needed). The CI now builds the packages, checks what would be published and installs the packed files in an empty project to run and type-check them, and it runs the suite against Better Auth 1.7.10 and 1.7.14.
- d9c4b80: `@teamblind/axeda-express` gains an optional `onDenied` hook that reports every refused request, with the exact reason the client is not told, so an application can log it; it never changes the response and a failing hook is ignored. All packages now declare a `default` export condition next to `types`, so they can be loaded from CommonJS with `require()` on Node 22.12 or later (and with `import()` everywhere); before, `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- 680ab7d: Fix three findings of the security review. A banned principal (for example one arriving through an API key) could still read roles, companies, businesses and other people's assignments; every use case now builds the actor's permission data in one place, which includes the ban. Listing the assignments of a scope answered differently for a company or business that exists and one that does not, which let any signed-in person probe for identifiers; both now answer the same unless the caller holds the permission globally. Every `/axeda/*` response, errors included, now carries `Cache-Control: no-store`.
- e7e5e56: Fix four problems found while reviewing the first alpha. With sessions kept in `secondaryStorage` (for example Redis), Better Auth keeps a stale copy of the user next to each session, so a revoked assignment, a ban or a 2FA change never reached it; the plugin endpoints and `sessionPrincipal` now re-read the user from the database when `secondaryStorage` is set, and a user who no longer exists is nobody (`principalFromSession` is now async). Dropping a role's `requireMfa` now requires covering all of its permissions, as reactivating it already did. `start()` retries after a transient failure such as an unreachable database instead of staying broken until the process restarts; configuration failures are still remembered. The startup transaction probe no longer reports a false "no transactions" when another instance syncs its roles at the same moment.
- 4b6cf64: Fix one management problem. Who manages the roles now can remove permissions, deactivate or delete an user only if their own permissions cover what is lost, just like remove an assignment. ´delete´ and ´setStatus´ demand cover all the rol permissions. Before, deactivate didn´t demand anything, just reactivate did. ´Update´ now demand cover the permissions what is lost. The rule is in a new function, ´permissionsToCover´ , because ESLint indicated that ´update´ surpassed complexity limit.
