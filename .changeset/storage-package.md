---
'@teamblind/axeda-storage': minor
'@teamblind/axeda-testing': minor
---

New package: the object storage behind Axeda images.

- `s3Storage({ endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl })` implements `ObjectStorage` for Cloudflare R2, Amazon S3, MinIO and other S3-compatible stores, with path-style addresses. It presigns uploads with the content type signed, reads with a byte cap, and signs every request with AWS Signature Version 4 on WebCrypto, without the AWS SDK.
- `sharpImageProcessor()` re-encodes uploaded images with `sharp` (an optional peer dependency): camera orientation applied, all metadata removed, first frame only, shrunk to fit.
- `@teamblind/axeda-testing` adds `runObjectStorageContract()` to check any `ObjectStorage` implementation.
