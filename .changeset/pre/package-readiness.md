---
'@teamblind/axeda-core': patch
'@teamblind/axeda-better-auth': patch
'@teamblind/axeda-express': patch
'@teamblind/axeda-testing': patch
---

Make the packages publishable: compiled ES modules with type declarations under `dist/`, an `exports` map, `files` limited to what is needed, a README, the licence and the notice in each tarball, and the dependencies each package really uses (`@teamblind/axeda-core` for the others, `zod`, and `vitest` and `@types/express` as peers where needed). The CI now builds the packages, checks what would be published and installs the packed files in an empty project to run and type-check them, and it runs the suite against Better Auth 1.7.10 and 1.7.14.
