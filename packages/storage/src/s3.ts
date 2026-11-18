import { AxedaError, type ObjectInfo, type ObjectStorage } from '@teamblind/axeda-core';
import { EMPTY_SHA256, presignUrl, sha256Hex, signRequest, uriEncode } from './sigv4.js';

export interface S3StorageOptions {
  /**
   * El servidor S3, sin el bucket: `https://<cuenta>.r2.cloudflarestorage.com` en R2,
   * `https://s3.<región>.amazonaws.com` en AWS. `http` solo para `localhost` (p. ej. MinIO).
   */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `auto` en R2 (por omisión); la región del bucket en AWS. */
  readonly region?: string;
  /**
   * Desde dónde se muestran las imágenes: un dominio propio del bucket (recomendado), la URL `r2.dev`
   * o una CDN delante. Sin barra final.
   */
  readonly publicBaseUrl: string;
  /**
   * Firma también el `Content-Length` de las subidas, para que el almacén rechace un archivo de otro
   * tamaño que el declarado. AWS y MinIO lo hacen cumplir; no está confirmado en R2, por eso va
   * apagado. Axeda comprueba el tamaño igualmente al completar la subida.
   */
  readonly signContentLength?: boolean;
  /** Para las pruebas. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const invalid = (message: string): never => {
  throw new AxedaError('AXEDA_INVALID_CONFIG', `Invalid storage options: ${message}`);
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Una URL https (o http en esta máquina), sin consulta ni credenciales. */
function baseUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(`${name} is not a URL.`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    invalid(`${name} must use https (http is only accepted for localhost).`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    invalid(`${name} must not carry credentials, a query or a fragment.`);
  }
  return url;
}

/** Nombre de bucket de S3: 3 a 63 caracteres en minúsculas, números, puntos y guiones. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function validate(options: S3StorageOptions) {
  const endpoint = baseUrl('endpoint', options.endpoint);
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
    invalid('endpoint must not include a path (the bucket goes in "bucket").');
  }
  if (!BUCKET.test(options.bucket)) invalid('bucket is not a valid bucket name.');
  if (options.accessKeyId.trim() === '' || options.secretAccessKey.trim() === '') {
    invalid('accessKeyId and secretAccessKey are required.');
  }
  const publicBase = baseUrl('publicBaseUrl', options.publicBaseUrl.replace(/\/+$/, ''));
  return { endpoint, publicBase: publicBase.toString().replace(/\/+$/, '') };
}

/** Una clave de objeto de Axeda: segmentos sencillos, nunca `..` ni rutas absolutas. */
function checkKey(key: string): string {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/.test(key) || key.includes('..')) {
    throw new AxedaError('AXEDA_INVALID_INPUT', `"${key}" is not a valid object key.`);
  }
  return key;
}

/** Un fallo del almacén, sin la URL (lleva el bucket) ni la respuesta (puede llevar detalles). */
const storageError = (operation: string, status: number): Error =>
  new Error(`Object storage ${operation} failed with HTTP ${status}.`);

/** Une los trozos leídos en un solo bloque. */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** Lee el cuerpo hasta `limit` bytes; si hay más, deja de leer y devuelve `'too_large'`. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | 'too_large'> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  const reader = response.body?.getReader();
  if (Number.isFinite(declared) && declared > limit) {
    await reader?.cancel();
    return 'too_large';
  }
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.length;
    if (total > limit) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(next.value);
  }
  return concat(chunks, total);
}

/**
 * Un almacén de objetos compatible con S3 (Cloudflare R2, AWS S3, MinIO, DigitalOcean Spaces,
 * Backblaze B2…) para las imágenes de Axeda. Usa direcciones de tipo «path»
 * (`<endpoint>/<bucket>/<clave>`), que todos aceptan.
 */
export function s3Storage(options: S3StorageOptions): ObjectStorage {
  const { endpoint, publicBase } = validate(options);
  const credentials = {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region ?? 'auto',
  };
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  const objectUrl = (key: string): URL =>
    new URL(`${endpoint.origin}/${uriEncode(options.bucket)}/${uriEncode(checkKey(key), true)}`);

  async function send(
    method: string,
    key: string,
    extra: { headers?: Record<string, string>; body?: Uint8Array; payloadHash?: string } = {},
  ): Promise<Response> {
    const url = objectUrl(key);
    const headers = await signRequest(credentials, {
      method,
      url,
      headers: extra.headers ?? {},
      payloadHash: extra.payloadHash ?? EMPTY_SHA256,
      date: now(),
    });
    return fetch(url, {
      method,
      headers,
      ...(extra.body === undefined ? {} : { body: extra.body }),
      redirect: 'error',
    });
  }

  return {
    async signUpload(key, upload) {
      const headers: Record<string, string> = { 'content-type': upload.contentType };
      if (options.signContentLength === true) {
        headers['content-length'] = String(upload.contentLength);
      }
      const url = await presignUrl(credentials, {
        method: 'PUT',
        url: objectUrl(key),
        headers,
        expiresInSeconds: upload.expiresInSeconds,
        date: now(),
      });
      // El navegador pone el Content-Length por su cuenta; no se le puede pedir que lo envíe.
      return {
        url: url.toString(),
        method: 'PUT',
        headers: { 'content-type': upload.contentType },
      };
    },

    async head(key): Promise<ObjectInfo | null> {
      const response = await send('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) throw storageError('HEAD', response.status);
      return {
        size: Number(response.headers.get('content-length') ?? 0),
        contentType: response.headers.get('content-type'),
      };
    },

    async read(key, maxBytes) {
      // Se pide un byte más del tope: si llega, el objeto es demasiado grande.
      const response = await send('GET', key, { headers: { range: `bytes=0-${maxBytes}` } });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      // 416: el objeto está vacío (no hay byte 0 que devolver).
      if (response.status === 416) return new Uint8Array();
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel();
        throw storageError('GET', response.status);
      }
      return readCapped(response, maxBytes);
    },

    async write(key, bytes, write) {
      const response = await send('PUT', key, {
        // `X-Content-Type-Options: nosniff` no se guarda con el objeto en S3: se pone en el dominio
        // o la CDN que sirve las imágenes (ver la guía).
        headers: { 'content-type': write.contentType, 'cache-control': write.cacheControl },
        body: bytes,
        payloadHash: await sha256Hex(bytes),
      });
      await response.body?.cancel();
      if (!response.ok) throw storageError('PUT', response.status);
    },

    async delete(key) {
      const response = await send('DELETE', key);
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw storageError('DELETE', response.status);
    },

    publicUrl: (key) => `${publicBase}/${uriEncode(checkKey(key), true)}`,
  };
}
