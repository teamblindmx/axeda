---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Add staff accounts: people who sign in with a username and a PIN, created by an administrator (waiters, cooks…), for businesses that work with shared terminals.

- New permission `axeda:staff:manage`, valid in a company, a business or a site. With it, `axeda.staff` creates staff there or below with a random PIN of 6 to 8 digits returned once, lists them by place, renames them, resets the PIN (closing their sessions), unlocks, suspends, reactivates and removes them. Staff change their own PIN by giving the current one.
- Usernames are unique within a company; signing in takes the company slug, the username and the PIN. `axeda.staff.signIn` answers the same `AXEDA_STAFF_SIGN_IN_FAILED` (401) for every failure, hashes even when there is no account, and locks an account after 5 wrong PINs for 15 minutes (`options.staff`); simultaneous attempts never go past the limit.
- A staff account never administers Axeda: a role with any Axeda permission (or `*`) cannot be given to it, and its effective permissions drop them even if a role is edited later.
- The PIN is not a password of the identity system: it lives in Axeda's own store, hashed with the new `pinHasher` dependency. Purging or deleting a company, business or site for good also removes its staff and their users.
- New: `options.staff`, `UserAdmin.delete`, error codes `AXEDA_USERNAME_TAKEN`, `AXEDA_STAFF_NOT_FOUND` and `AXEDA_STAFF_SIGN_IN_FAILED`, audit actions `staff.*`, a `staff` store in `AxedaPersistence` (Better Auth table `axedaStaff`) checked by `runPersistenceContract`, and `createTestPinHasher()` in `@teamblind/axeda-testing`.
