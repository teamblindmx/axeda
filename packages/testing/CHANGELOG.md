# @teamblind/axeda-testing

## 0.1.0-alpha.3

### Minor Changes

- 94bb097: Add images: logos and favicons of companies, businesses and sites, and profile pictures, uploaded straight from the browser to an object storage (Cloudflare R2, S3, MinIO…) with a signed URL.

  - `axeda.images.createUpload(actor, { purpose, targetId, contentType, size })` checks the same permission as editing that entity (or, for `user.avatar`, that it is the person or a user administrator), accepts only PNG, JPEG and WebP up to 2 MiB, and returns a signed PUT URL valid 10 minutes. `completeUpload(actor, uploadId)` reads the file with a byte cap, decides its type by its bytes (never by what was declared), checks its dimensions (4096 px per side, 1024 for a favicon), re-encodes it if an `imageProcessor` is configured, stores it under a random key and puts its public URL on the entity, deleting the previous image. `remove` takes it away. All of it is audited (`image.set`, `image.remove`).
  - New dependencies of `createAxeda`: `storage` (an `ObjectStorage`) and the optional `imageProcessor`. Without `storage`, images answer `AXEDA_FEATURE_DISABLED`. New options under `images` for the limits. New error codes `AXEDA_IMAGE_INVALID` and `AXEDA_UPLOAD_INVALID` (400).
  - `purgeDeleted()` also deletes the images of what it purges and the uploads nobody completed, and returns `images`. Deleting a company, business or site with `immediate` deletes its images too.
  - `ManagedUser` has `image`. `UserAdmin.setImage` is optional; without it there are no profile pictures.
  - Better Auth's migration creates the table `axedaImage`.
  - If you wrote your own persistence, `AxedaPersistence` needs an `images` store (`ImageStore`); `runPersistenceContract` checks it. `@teamblind/axeda-testing` adds `createMemoryStorage()`.

- 9eaf432: New package: the object storage behind Axeda images.

  - `s3Storage({ endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl })` implements `ObjectStorage` for Cloudflare R2, Amazon S3, MinIO and other S3-compatible stores, with path-style addresses. It presigns uploads with the content type signed, reads with a byte cap, and signs every request with AWS Signature Version 4 on WebCrypto, without the AWS SDK.
  - `sharpImageProcessor()` re-encodes uploaded images with `sharp` (an optional peer dependency): camera orientation applied, all metadata removed, first frame only, shrunk to fit.
  - `@teamblind/axeda-testing` adds `runObjectStorageContract()` to check any `ObjectStorage` implementation.

### Patch Changes

- Updated dependencies [94bb097]
- Updated dependencies [ee80196]
  - @teamblind/axeda-core@0.1.0-alpha.3

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

### Patch Changes

- Updated dependencies [71ae834]
- Updated dependencies [6a6f3a0]
  - @teamblind/axeda-core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- No changes of its own. It is versioned together with the other packages so that the four share one version, and it now depends on `@teamblind/axeda-core` `0.1.0-alpha.1`.
- Updated dependencies [ce83aff]
  - @teamblind/axeda-core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- b519956: Add the authorization use cases. `@teamblind/axeda-core` gains role management, assignments with the no-escalation rule (also on revoke and on role edits), an append-only audit log, `bootstrap` for the first administrator, roles declared in code that sync at start, `scopesFor` and `scopeFilter`, and a version-validated permission cache. `requireMfa` is now enforced when deciding. `@teamblind/axeda-better-auth` stores the audit log and exposes `createBetterAuthUserDirectory`; `@teamblind/axeda-testing` adds an in-memory user directory and covers the new ports in the contract suite.

  The Better Auth plugin now exposes the use cases as `/axeda/*` endpoints (every one requires a session and declares its permission), connects the session to the actor, cleans up on user deletion, refuses to start with `session.cookieCache`, and ships a typed client at `@teamblind/axeda-better-auth/client`. `npm run demo` runs the whole story against a real server.

- c55b0f4: Persist Axeda on top of the Better Auth database adapter. `@teamblind/axeda-better-auth` adds the plugin schema (roles, assignments, policy state and the user's `authzVersion`) and `createBetterAuthPersistence`, which implements the persistence ports for any database Better Auth supports, with atomic counters, optimistic role updates and real transactions. The persistence contract suite now also covers concurrent duplicate creation, and `@teamblind/axeda-core` adds the `AXEDA_USER_NOT_FOUND` and `AXEDA_DATA_CORRUPT` error codes.
- c6a80da: Add companies, businesses, invitations and public identity. Companies and businesses are real entities with versions, soft deletion with a grace period (and immediate deletion for privacy requests) and a status that silences their people at once; business scopes are now resolved from the database, never from the request. Invitations are single-use, only the owner of the verified email can accept them, and the inviter's current power is re-checked on acceptance. The plugin exposes `/axeda/company/*`, `/axeda/business/*`, `/axeda/invitation/*` and an opt-in `/axeda/public/identity`; the HTTP status of every error code is now decided exhaustively.
- a836007: Add the authorization core: permission keys with wildcards, scope inheritance (global → company → business), effective permissions, the no-escalation grant rule, persistence ports, option validation and `createAxeda` with a startup transaction check. `@teamblind/axeda-testing` adds an in-memory persistence with real transactions and a persistence contract suite.
- b402e20: Add user administration and menus. Platform administrators can list users, create accounts without any credential, ban and unban (with an optional end date) and sign people out everywhere; a user with more administrative power than the actor cannot be touched, a ban applies to every path including API keys, and a banned account cannot open sessions. Menus are declared in code, validated at startup (every entry needs its permission, no cycles, safe paths) and `GET /axeda/menu` returns only what the person may use in the requested scope, in their language.

### Patch Changes

- fed4ed1: Make the packages publishable: compiled ES modules with type declarations under `dist/`, an `exports` map, `files` limited to what is needed, a README, the licence and the notice in each tarball, and the dependencies each package really uses (`@teamblind/axeda-core` for the others, `zod`, and `vitest` and `@types/express` as peers where needed). The CI now builds the packages, checks what would be published and installs the packed files in an empty project to run and type-check them, and it runs the suite against Better Auth 1.7.10 and 1.7.14.
- d9c4b80: `@teamblind/axeda-express` gains an optional `onDenied` hook that reports every refused request, with the exact reason the client is not told, so an application can log it; it never changes the response and a failing hook is ignored. All packages now declare a `default` export condition next to `types`, so they can be loaded from CommonJS with `require()` on Node 22.12 or later (and with `import()` everywhere); before, `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Updated dependencies [b519956]
- Updated dependencies [c55b0f4]
- Updated dependencies [c6a80da]
- Updated dependencies [a836007]
- Updated dependencies [7ebf1fd]
- Updated dependencies [fed4ed1]
- Updated dependencies [d9c4b80]
- Updated dependencies [680ab7d]
- Updated dependencies [b402e20]
  - @teamblind/axeda-core@0.1.0-alpha.0
