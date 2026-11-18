import type { ImageFormat, ImagePurpose, ImageRecord } from '../domain/image.js';

/** Una subida firmada: el navegador manda el archivo con `method` a `url` y estas cabeceras. */
export interface SignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  /** Cabeceras que el navegador debe enviar tal cual (al menos `content-type`). */
  readonly headers: Readonly<Record<string, string>>;
}

export interface ObjectInfo {
  readonly size: number;
  readonly contentType: string | null;
}

/**
 * Almacén de objetos (Cloudflare R2, S3, MinIO…). Axeda nunca recibe los bytes de una subida: firma
 * una URL y después lee el objeto **con un tope** para comprobarlo.
 */
export interface ObjectStorage {
  /** Una URL para subir `key` con PUT, con ese `Content-Type` firmado, válida `expiresInSeconds`. */
  signUpload(
    key: string,
    options: {
      readonly contentType: string;
      readonly contentLength: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<SignedUpload>;
  /** Tamaño y tipo del objeto, o `null` si no existe. */
  head(key: string): Promise<ObjectInfo | null>;
  /**
   * El contenido del objeto, o `null` si no existe. Si pesa más de `maxBytes` devuelve `'too_large'`
   * sin leerlo entero.
   */
  read(key: string, maxBytes: number): Promise<Uint8Array | 'too_large' | null>;
  write(
    key: string,
    bytes: Uint8Array,
    options: { readonly contentType: string; readonly cacheControl: string },
  ): Promise<void>;
  /** Borrar algo que no existe no es un error. */
  delete(key: string): Promise<void>;
  /** La URL pública con la que se muestra el objeto. */
  publicUrl(key: string): string;
}

export interface ProcessedImage {
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
}

/**
 * Recodifica una imagen ya comprobada: quita metadatos (como la ubicación) y lo que vaya escondido,
 * y la reduce si pasa de `maxDimension`. Opcional (p. ej. con `sharp`).
 */
export interface ImageProcessor {
  process(
    bytes: Uint8Array,
    options: { readonly format: ImageFormat; readonly maxDimension: number },
  ): Promise<ProcessedImage>;
}

export interface NewImageUpload {
  readonly purpose: ImagePurpose;
  readonly targetId: string;
  readonly companyId: string | null;
  readonly businessId: string | null;
  readonly uploadKey: string;
  readonly contentType: string;
  readonly size: number;
  readonly uploadedBy: string;
  readonly expiresAt: Date;
}

export interface ReadyImage {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly width: number;
  readonly height: number;
}

/** De quién son las imágenes que se purgan con su compañía, negocio o sede. */
export interface ImageOwners {
  readonly companyIds: readonly string[];
  readonly businessIds: readonly string[];
  readonly siteIds: readonly string[];
}

/** Registro de las imágenes y de sus subidas pendientes. */
export interface ImageStore {
  get(id: string): Promise<ImageRecord | null>;
  createUpload(input: NewImageUpload): Promise<ImageRecord>;
  /** Subidas pendientes de esa persona que aún no han caducado. */
  countPendingBy(userId: string, now: Date): Promise<number>;
  /** La imagen lista de ese propósito y entidad, si la hay. */
  findCurrent(purpose: ImagePurpose, targetId: string): Promise<ImageRecord | null>;
  /**
   * Pasa una subida de pendiente a lista, de forma **atómica**: de dos llamadas solo una lo
   * consigue (las demás reciben `null`). Solo puede haber una imagen lista por propósito y entidad:
   * si ya hay otra lanza `AXEDA_VERSION_CONFLICT` (hay que borrar la anterior antes).
   */
  markReady(id: string, image: ReadyImage): Promise<ImageRecord | null>;
  /** Devuelve `false` si no existía. */
  delete(id: string): Promise<boolean>;
  /** Subidas pendientes que caducaron antes de `before`. */
  listExpiredUploads(before: Date, limit: number): Promise<readonly ImageRecord[]>;
  /**
   * Borra las imágenes (listas o pendientes) de esas compañías (con todo lo suyo), negocios (con sus
   * sedes) y sedes, y las devuelve para borrar sus objetos.
   */
  deleteOwnedBy(owners: ImageOwners): Promise<readonly ImageRecord[]>;
  /** Borra las imágenes de ese usuario (su avatar) y las devuelve. */
  deleteForUser(userId: string): Promise<readonly ImageRecord[]>;
}
