# @teamblind/axeda-storage

Object storage for the images of Axeda (logos, favicons and profile pictures): Cloudflare R2, Amazon S3, MinIO and any other S3-compatible store. The browser uploads straight to the store with a signed URL, so the bytes never go through your server. Requests are signed with AWS Signature Version 4 on WebCrypto: there is no AWS SDK to install.

> **Status:** alpha (`0.1.0-alpha.3`); the API can still change before 1.0. Install with `npm install @teamblind/axeda-storage@alpha`. Documentation: [English](https://github.com/teamblindmx/axeda/tree/main/docs/en) · [Español](https://github.com/teamblindmx/axeda/tree/main/docs/es).

```ts
import { createAxeda } from '@teamblind/axeda-core';
import { s3Storage, sharpImageProcessor } from '@teamblind/axeda-storage';

const storage = s3Storage({
  endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
  bucket: 'acme-images',
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  publicBaseUrl: 'https://images.acme.com',
});

const axeda = createAxeda(options, {
  persistence,
  users,
  storage,
  // Optional: re-encode every image and drop its metadata (npm install sharp).
  imageProcessor: sharpImageProcessor(),
});
```

## Options

| Option              | Default      | What it does                                                                                                                            |
| ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`          | — (required) | The S3 server, without the bucket. `https`; `http` only for `localhost`                                                                 |
| `bucket`            | — (required) | A valid S3 bucket name                                                                                                                  |
| `accessKeyId`       | — (required) | A key that can read, write and delete objects in **that bucket only**                                                                   |
| `secretAccessKey`   | — (required) | Its secret. Never logged nor put in an error                                                                                            |
| `region`            | `'auto'`     | `auto` for R2; the bucket's region for AWS                                                                                              |
| `publicBaseUrl`     | — (required) | Where images are shown from: the bucket's own domain (recommended), its `r2.dev` URL or a CDN                                           |
| `signContentLength` | `false`      | Also sign the upload size, so the store refuses another size. AWS and MinIO enforce it; R2 is unconfirmed. Axeda checks the size anyway |

`sharpImageProcessor({ quality })` (1–100, default 82) applies the camera orientation, removes every metadata block (EXIF with the location, ICC, XMP), keeps the first frame, shrinks the image to fit and keeps its format. `sharp` is an optional peer dependency.

## Setting up Cloudflare R2

1. **Bucket and key.** Create a bucket and an API token with _Object Read & Write_ limited to that bucket. Use the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
2. **CORS**, so the browser can upload. Signed URLs only work on that S3 endpoint, not on your domain:
   ```json
   [
     {
       "AllowedOrigins": ["https://app.acme.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
3. **Public domain.** Connect a domain of yours to the bucket (`images.acme.com`) and use it as `publicBaseUrl`. Serve images from a domain that is **not** your application's, and add a response header rule for `X-Content-Type-Options: nosniff`.
4. **Uploads in progress.** Files are uploaded under `uploads/` and moved to `images/` once checked. Add a lifecycle rule that deletes `uploads/` after 1 day, and block `/uploads/*` on the public domain, so an unchecked file is never served.

Axeda also deletes uploads nobody completed when you call `purgeDeleted()`.

Guides: [Configuration](https://github.com/teamblindmx/axeda/blob/main/docs/en/configuration.md) · [Reference](https://github.com/teamblindmx/axeda/blob/main/docs/en/reference.md) · [Upgrading](https://github.com/teamblindmx/axeda/blob/main/docs/en/upgrading.md).

Part of [Axeda](https://github.com/teamblindmx/axeda), hierarchical authorization (global → company → business → site) on top of [Better Auth](https://www.better-auth.com). Licensed under [Apache-2.0](LICENSE).
