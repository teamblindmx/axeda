# @teamblind/axeda-express

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
