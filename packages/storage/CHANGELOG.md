# @teamblind/axeda-storage

## 0.1.0-alpha.4

### Minor Changes

- a9f5bde: Misspelled options are an error instead of being silently ignored. `axeda()` (and its `invitationDelivery`), `secureAuthOptions()`, `securePhoneNumberOptions()`, `createAxedaExpress()`, `requirePermission()`, `resolveScope()`, `s3Storage()` and `sharpImageProcessor()` throw `AXEDA_INVALID_CONFIG` for an option nobody reads, naming the one it probably meant (`unknown option "publicIdentiy". Did you mean "publicIdentity"?`). A misspelled `requirePermission` scope or `resolveScope` source used to check the permission in global instead of in the route. The core exports `rejectUnknownOptions` for your own helpers.

  **Check before upgrading:** if your application passed an option that does not exist, it now fails at startup with that message.

### Patch Changes

- Updated dependencies [16d834d]
- Updated dependencies [c26c30e]
- Updated dependencies [ea22d5a]
- Updated dependencies [8f974cf]
- Updated dependencies [fde7b4b]
- Updated dependencies [a9f5bde]
  - @teamblind/axeda-core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- 9eaf432: New package: the object storage behind Axeda images.

  - `s3Storage({ endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl })` implements `ObjectStorage` for Cloudflare R2, Amazon S3, MinIO and other S3-compatible stores, with path-style addresses. It presigns uploads with the content type signed, reads with a byte cap, and signs every request with AWS Signature Version 4 on WebCrypto, without the AWS SDK.
  - `sharpImageProcessor()` re-encodes uploaded images with `sharp` (an optional peer dependency): camera orientation applied, all metadata removed, first frame only, shrunk to fit.
  - `@teamblind/axeda-testing` adds `runObjectStorageContract()` to check any `ObjectStorage` implementation.

### Patch Changes

- Updated dependencies [94bb097]
- Updated dependencies [ee80196]
  - @teamblind/axeda-core@0.1.0-alpha.3
