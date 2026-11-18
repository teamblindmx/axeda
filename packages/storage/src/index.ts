// @teamblind/axeda-storage — almacén de objetos para las imágenes de Axeda (R2, S3, MinIO…).
export {
  EMPTY_SHA256,
  UNSIGNED_PAYLOAD,
  presignUrl,
  sha256Hex,
  signRequest,
  type Credentials,
} from './sigv4.js';
export { s3Storage, type S3StorageOptions } from './s3.js';
