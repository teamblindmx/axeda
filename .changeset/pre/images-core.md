---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Add images: logos and favicons of companies, businesses and sites, and profile pictures, uploaded straight from the browser to an object storage (Cloudflare R2, S3, MinIO…) with a signed URL.

- `axeda.images.createUpload(actor, { purpose, targetId, contentType, size })` checks the same permission as editing that entity (or, for `user.avatar`, that it is the person or a user administrator), accepts only PNG, JPEG and WebP up to 2 MiB, and returns a signed PUT URL valid 10 minutes. `completeUpload(actor, uploadId)` reads the file with a byte cap, decides its type by its bytes (never by what was declared), checks its dimensions (4096 px per side, 1024 for a favicon), re-encodes it if an `imageProcessor` is configured, stores it under a random key and puts its public URL on the entity, deleting the previous image. `remove` takes it away. All of it is audited (`image.set`, `image.remove`).
- New dependencies of `createAxeda`: `storage` (an `ObjectStorage`) and the optional `imageProcessor`. Without `storage`, images answer `AXEDA_FEATURE_DISABLED`. New options under `images` for the limits. New error codes `AXEDA_IMAGE_INVALID` and `AXEDA_UPLOAD_INVALID` (400).
- `purgeDeleted()` also deletes the images of what it purges and the uploads nobody completed, and returns `images`. Deleting a company, business or site with `immediate` deletes its images too.
- `ManagedUser` has `image`. `UserAdmin.setImage` is optional; without it there are no profile pictures.
- Better Auth's migration creates the table `axedaImage`.
- If you wrote your own persistence, `AxedaPersistence` needs an `images` store (`ImageStore`); `runPersistenceContract` checks it. `@teamblind/axeda-testing` adds `createMemoryStorage()`.
