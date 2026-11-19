---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-express': minor
'@teamblind/axeda-storage': minor
---

Misspelled options are an error instead of being silently ignored. `axeda()` (and its `invitationDelivery`), `secureAuthOptions()`, `securePhoneNumberOptions()`, `createAxedaExpress()`, `requirePermission()`, `resolveScope()`, `s3Storage()` and `sharpImageProcessor()` throw `AXEDA_INVALID_CONFIG` for an option nobody reads, naming the one it probably meant (`unknown option "publicIdentiy". Did you mean "publicIdentity"?`). A misspelled `requirePermission` scope or `resolveScope` source used to check the permission in global instead of in the route. The core exports `rejectUnknownOptions` for your own helpers.

**Check before upgrading:** if your application passed an option that does not exist, it now fails at startup with that message.
