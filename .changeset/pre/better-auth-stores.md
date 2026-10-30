---
'@axeda/better-auth': minor
'@axeda/core': minor
'@axeda/testing': minor
---

Persist Axeda on top of the Better Auth database adapter. `@axeda/better-auth` adds the plugin schema (roles, assignments, policy state and the user's `authzVersion`) and `createBetterAuthPersistence`, which implements the persistence ports for any database Better Auth supports, with atomic counters, optimistic role updates and real transactions. The persistence contract suite now also covers concurrent duplicate creation, and `@axeda/core` adds the `AXEDA_USER_NOT_FOUND` and `AXEDA_DATA_CORRUPT` error codes.
