---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Add companies, businesses, invitations and public identity. Companies and businesses are real entities with versions, soft deletion with a grace period (and immediate deletion for privacy requests) and a status that silences their people at once; business scopes are now resolved from the database, never from the request. Invitations are single-use, only the owner of the verified email can accept them, and the inviter's current power is re-checked on acceptance. The plugin exposes `/axeda/company/*`, `/axeda/business/*`, `/axeda/invitation/*` and an opt-in `/axeda/public/identity`; the HTTP status of every error code is now decided exhaustively.
