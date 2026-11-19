---
'@teamblind/axeda-core': patch
'@teamblind/axeda-better-auth': patch
'@teamblind/axeda-testing': patch
---

Security review of staff accounts:

- **Resetting a PIN no longer lets a manager take over someone with more permissions.** A new PIN means signing in as that person, so `staff/reset-pin` now also requires the actor to hold every permission the account holds, wherever it holds it (`403`, reason `exceeds_granter_permissions`, with the missing permissions).
- **Each lock in a row lasts twice as long** (15 minutes, 30, 1 hour…, up to a day) until the right PIN gets in, so slow PIN guessing no longer gets 5 tries every 15 minutes forever. Staff accounts gain `lockCount`; `AttemptPolicy` gains `maxLockMs` and `lockDuration` is exported for custom stores.
- **The audit log records the client address behind trusted proxies.** Axeda now reads it with Better Auth's own `advanced.ipAddress` options (`trustedProxies`, `ipAddressHeaders`), as its rate limiter does, instead of ignoring them.
