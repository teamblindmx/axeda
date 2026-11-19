# @teamblind/axeda-express

## 0.1.0-alpha.3

### Patch Changes

- No changes of its own: this version follows `@teamblind/axeda-core` 0.1.0-alpha.3 (images), so all the packages share one version.

## 0.1.0-alpha.2

### Minor Changes

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

- 7ebf1fd: Add Express middleware, a secure Better Auth preset and the first documentation. `@teamblind/axeda-express` provides `requireAuth()`, `requirePermission()` and `resolveScope()`: it denies by default, resolves the company of a business from the database, answers the same whether a scope exists or not, requires a trusted origin for cookie-bearing writes and never fails open. `@teamblind/axeda-better-auth` adds `secureAuthOptions()` (refuses weak secrets, wildcard or plain-http origins), `sessionPrincipal()` and `principalFromUser()`, and the plugin now refuses to start with Better Auth's CSRF check, origin check or IP tracking disabled. `@teamblind/axeda-core` adds `resolveTarget()` so applications never trust a company id sent by the client. Documentation in English and Spanish, and an example API in `apps/example`.
- d9c4b80: `@teamblind/axeda-express` gains an optional `onDenied` hook that reports every refused request, with the exact reason the client is not told, so an application can log it; it never changes the response and a failing hook is ignored. All packages now declare a `default` export condition next to `types`, so they can be loaded from CommonJS with `require()` on Node 22.12 or later (and with `import()` everywhere); before, `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Patch Changes

- fed4ed1: Make the packages publishable: compiled ES modules with type declarations under `dist/`, an `exports` map, `files` limited to what is needed, a README, the licence and the notice in each tarball, and the dependencies each package really uses (`@teamblind/axeda-core` for the others, `zod`, and `vitest` and `@types/express` as peers where needed). The CI now builds the packages, checks what would be published and installs the packed files in an empty project to run and type-check them, and it runs the suite against Better Auth 1.7.10 and 1.7.14.
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
