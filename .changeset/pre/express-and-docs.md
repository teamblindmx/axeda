---
'@axeda/core': minor
'@axeda/better-auth': minor
'@axeda/express': minor
---

Add Express middleware, a secure Better Auth preset and the first documentation. `@axeda/express` provides `requireAuth()`, `requirePermission()` and `resolveScope()`: it denies by default, resolves the company of a business from the database, answers the same whether a scope exists or not, requires a trusted origin for cookie-bearing writes and never fails open. `@axeda/better-auth` adds `secureAuthOptions()` (refuses weak secrets, wildcard or plain-http origins), `sessionPrincipal()` and `principalFromUser()`, and the plugin now refuses to start with Better Auth's CSRF check, origin check or IP tracking disabled. `@axeda/core` adds `resolveTarget()` so applications never trust a company id sent by the client. Documentation in English and Spanish, and an example API in `apps/example`.
