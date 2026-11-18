---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Add access by phone number, and invitations by phone.

- `securePhoneNumberOptions({ sendOTP })` returns safe options for Better Auth's `phoneNumber` plugin: 6-digit codes valid 5 minutes with 3 attempts, E.164 numbers only, sign-up on verification with a placeholder email (`…@phone.invalid`, recognised by `isPhoneOnlyEmail`), and a cap on the codes sent to one number per window (5 per hour by default) that holds whatever the address asking and across instances. `secureAuthOptions` adds rate limits for the phone routes.
- `axeda.invitations.create` and `POST /axeda/invitation/create` take exactly one of `email` or `phoneNumber`. A phone invitation is accepted only by an account whose verified phone number is the invited one. Invitations carry `channel` and `phoneNumber`, and `invitationDelivery.send` receives them.
- Users carry `phoneNumber` and `phoneNumberVerified` (`null` and `false` without access by phone), in the core, the directory, user administration and `/axeda/user/*`.
- Better Auth's migration creates the table `axedaThrottle` and adds the optional column `channel` to `axedaInvitation`; existing invitations stay invitations by email.
- If you wrote your own persistence, invitations have a `channel` and `findPending` looks up by contact (`invitationContact`); a custom `UserAdmin` must return the two phone fields. `runPersistenceContract` checks the stores.
