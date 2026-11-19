---
'@teamblind/axeda-better-auth': minor
---

Staff accounts over HTTP, in the Better Auth plugin.

- `POST /axeda/staff/sign-in` (no session needed) takes `{ company, username, pin }` and opens a regular Better Auth session with its cookie. It is limited to 10 attempts a minute per address, on top of the per-account lock.
- `/axeda/staff/{list,get,create,rename,reset-pin,unlock,suspend,reactivate,remove}` with `axeda:staff:manage`, and `/axeda/staff/change-pin` for a staff member's own PIN. `staff/create` returns the PIN once. Typed client: `client.axeda.staff.*`.
- PINs are hashed with Better Auth's password hashing and a key derived from its `secret`; they never work on Better Auth's email sign-in. Deleting a user through Better Auth removes its staff account.
- `axeda({ staff: { pinLength, maxAttempts, lockMinutes } })`. Better Auth's migration creates the table `axedaStaff`.
