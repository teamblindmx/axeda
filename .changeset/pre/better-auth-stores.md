---
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-core': minor
'@teamblind/axeda-testing': minor
---

Persist Axeda on top of the Better Auth database adapter. `@teamblind/axeda-better-auth` adds the plugin schema (roles, assignments, policy state and the user's `authzVersion`) and `createBetterAuthPersistence`, which implements the persistence ports for any database Better Auth supports, with atomic counters, optimistic role updates and real transactions. The persistence contract suite now also covers concurrent duplicate creation, and `@teamblind/axeda-core` adds the `AXEDA_USER_NOT_FOUND` and `AXEDA_DATA_CORRUPT` error codes.
