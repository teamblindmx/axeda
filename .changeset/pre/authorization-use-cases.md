---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Add the authorization use cases. `@teamblind/axeda-core` gains role management, assignments with the no-escalation rule (also on revoke and on role edits), an append-only audit log, `bootstrap` for the first administrator, roles declared in code that sync at start, `scopesFor` and `scopeFilter`, and a version-validated permission cache. `requireMfa` is now enforced when deciding. `@teamblind/axeda-better-auth` stores the audit log and exposes `createBetterAuthUserDirectory`; `@teamblind/axeda-testing` adds an in-memory user directory and covers the new ports in the contract suite.

The Better Auth plugin now exposes the use cases as `/axeda/*` endpoints (every one requires a session and declares its permission), connects the session to the actor, cleans up on user deletion, refuses to start with `session.cookieCache`, and ships a typed client at `@teamblind/axeda-better-auth/client`. `npm run demo` runs the whole story against a real server.
