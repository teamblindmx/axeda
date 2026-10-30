---
'@axeda/core': minor
'@axeda/better-auth': minor
'@axeda/testing': minor
---

Add user administration and menus. Platform administrators can list users, create accounts without any credential, ban and unban (with an optional end date) and sign people out everywhere; a user with more administrative power than the actor cannot be touched, a ban applies to every path including API keys, and a banned account cannot open sessions. Menus are declared in code, validated at startup (every entry needs its permission, no cycles, safe paths) and `GET /axeda/menu` returns only what the person may use in the requested scope, in their language.
