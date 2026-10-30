# @axeda/testing

## 0.1.0-alpha.0

### Minor Changes

- b519956: Add the authorization use cases. `@axeda/core` gains role management, assignments with the no-escalation rule (also on revoke and on role edits), an append-only audit log, `bootstrap` for the first administrator, roles declared in code that sync at start, `scopesFor` and `scopeFilter`, and a version-validated permission cache. `requireMfa` is now enforced when deciding. `@axeda/better-auth` stores the audit log and exposes `createBetterAuthUserDirectory`; `@axeda/testing` adds an in-memory user directory and covers the new ports in the contract suite.

  The Better Auth plugin now exposes the use cases as `/axeda/*` endpoints (every one requires a session and declares its permission), connects the session to the actor, cleans up on user deletion, refuses to start with `session.cookieCache`, and ships a typed client at `@axeda/better-auth/client`. `npm run demo` runs the whole story against a real server.

- c55b0f4: Persist Axeda on top of the Better Auth database adapter. `@axeda/better-auth` adds the plugin schema (roles, assignments, policy state and the user's `authzVersion`) and `createBetterAuthPersistence`, which implements the persistence ports for any database Better Auth supports, with atomic counters, optimistic role updates and real transactions. The persistence contract suite now also covers concurrent duplicate creation, and `@axeda/core` adds the `AXEDA_USER_NOT_FOUND` and `AXEDA_DATA_CORRUPT` error codes.
- c6a80da: Add companies, businesses, invitations and public identity. Companies and businesses are real entities with versions, soft deletion with a grace period (and immediate deletion for privacy requests) and a status that silences their people at once; business scopes are now resolved from the database, never from the request. Invitations are single-use, only the owner of the verified email can accept them, and the inviter's current power is re-checked on acceptance. The plugin exposes `/axeda/company/*`, `/axeda/business/*`, `/axeda/invitation/*` and an opt-in `/axeda/public/identity`; the HTTP status of every error code is now decided exhaustively.
- a836007: Add the authorization core: permission keys with wildcards, scope inheritance (global → company → business), effective permissions, the no-escalation grant rule, persistence ports, option validation and `createAxeda` with a startup transaction check. `@axeda/testing` adds an in-memory persistence with real transactions and a persistence contract suite.
- b402e20: Add user administration and menus. Platform administrators can list users, create accounts without any credential, ban and unban (with an optional end date) and sign people out everywhere; a user with more administrative power than the actor cannot be touched, a ban applies to every path including API keys, and a banned account cannot open sessions. Menus are declared in code, validated at startup (every entry needs its permission, no cycles, safe paths) and `GET /axeda/menu` returns only what the person may use in the requested scope, in their language.

### Patch Changes

- fed4ed1: Make the packages publishable: compiled ES modules with type declarations under `dist/`, an `exports` map, `files` limited to what is needed, a README, the licence and the notice in each tarball, and the dependencies each package really uses (`@axeda/core` for the others, `zod`, and `vitest` and `@types/express` as peers where needed). The CI now builds the packages, checks what would be published and installs the packed files in an empty project to run and type-check them, and it runs the suite against Better Auth 1.7.10 and 1.7.14.
- d9c4b80: `@axeda/express` gains an optional `onDenied` hook that reports every refused request, with the exact reason the client is not told, so an application can log it; it never changes the response and a failing hook is ignored. All packages now declare a `default` export condition next to `types`, so they can be loaded from CommonJS with `require()` on Node 22.12 or later (and with `import()` everywhere); before, `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Updated dependencies [b519956]
- Updated dependencies [c55b0f4]
- Updated dependencies [c6a80da]
- Updated dependencies [a836007]
- Updated dependencies [7ebf1fd]
- Updated dependencies [fed4ed1]
- Updated dependencies [d9c4b80]
- Updated dependencies [680ab7d]
- Updated dependencies [b402e20]
  - @axeda/core@0.1.0-alpha.0
