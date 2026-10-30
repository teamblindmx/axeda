---
'@teamblind/axeda-core': patch
'@teamblind/axeda-better-auth': patch
---

Fix four problems found while reviewing the first alpha. With sessions kept in `secondaryStorage` (for example Redis), Better Auth keeps a stale copy of the user next to each session, so a revoked assignment, a ban or a 2FA change never reached it; the plugin endpoints and `sessionPrincipal` now re-read the user from the database when `secondaryStorage` is set, and a user who no longer exists is nobody (`principalFromSession` is now async). Dropping a role's `requireMfa` now requires covering all of its permissions, as reactivating it already did. `start()` retries after a transient failure such as an unreachable database instead of staying broken until the process restarts; configuration failures are still remembered. The startup transaction probe no longer reports a false "no transactions" when another instance syncs its roles at the same moment.
