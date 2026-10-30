---
'@axeda/express': minor
'@axeda/core': patch
'@axeda/better-auth': patch
'@axeda/testing': patch
---

`@axeda/express` gains an optional `onDenied` hook that reports every refused request, with the exact reason the client is not told, so an application can log it; it never changes the response and a failing hook is ignored. All packages now declare a `default` export condition next to `types`, so they can be loaded from CommonJS with `require()` on Node 22.12 or later (and with `import()` everywhere); before, `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
