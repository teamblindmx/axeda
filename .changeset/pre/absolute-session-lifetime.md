---
'@teamblind/axeda-better-auth': minor
---

Add an absolute lifetime to sessions. Better Auth renews a session every time it is used, so a session in daily use never ended. The plugin now cuts a session's expiry, when it is created and on every renewal, so it never goes past its creation plus `maxSessionAge` (30 days by default, in seconds; `false` turns it off). It applies in Better Auth's own endpoints and in your routes, with sessions in the database or in `secondaryStorage`, and signing in again starts a new count. Sessions that are already older than 30 days are cut the next time Better Auth renews them. While the limit holds a session back, Better Auth writes the session row on every request during the last `session.expiresIn` minus `session.updateAge` of its life, instead of once a day.
