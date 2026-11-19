---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
---

Images over HTTP and in the Better Auth plugin.

- `axeda({ storage, imageProcessor, images })` passes the object storage (for example `s3Storage()` of `@teamblind/axeda-storage`), the optional processor and the image limits to the core.
- New endpoints `POST /axeda/image/upload` (returns the signed PUT for the browser: `uploadId`, `url`, `method`, `headers`, `expiresAt`), `POST /axeda/image/complete` and `POST /axeda/image/remove`, with the typed client (`client.axeda.image.*`). Without `storage` they answer `AXEDA_FEATURE_DISABLED` (501).
- Profile pictures are written to Better Auth's `user.image`, and `/axeda/user/*` returns `image`. Deleting a user through Better Auth deletes their picture.
- `IMAGE_CONTENT_TYPES` is a closed list (`ImageContentType`), so the client refuses an unsupported type at compile time.
