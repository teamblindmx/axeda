/**
 * AWS Signature Version 4 sobre WebCrypto, lo justo para S3 y los almacenes compatibles (R2, MinIO,
 * Spaces, B2): firmar una petición con la cabecera `Authorization` o como URL prefirmada. Sin el SDK
 * de AWS. Se prueba contra los ejemplos de la documentación de AWS.
 */

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `auto` en R2. */
  readonly region: string;
  readonly service?: string;
}

/** SHA-256 de una carga vacía: la de GET, HEAD y DELETE. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  // Una copia propia: WebCrypto no acepta vistas sobre un SharedArrayBuffer.
  const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(
  key: Uint8Array<ArrayBuffer> | ArrayBuffer,
  data: string,
): Promise<ArrayBuffer> {
  const imported = await globalThis.crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return globalThis.crypto.subtle.sign('HMAC', imported, encoder.encode(data));
}

/** Codificación de URI de SigV4 (RFC 3986): todo salvo `A-Z a-z 0-9 - _ . ~`, y `/` si se pide. */
export function uriEncode(value: string, keepSlash = false): string {
  return Array.from(encoder.encode(value), (byte) => {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === '/')) return char;
    return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

/** `20130524T000000Z` y `20130524`. */
export function amzDates(date: Date): { stamp: string; day: string } {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

const canonicalQuery = (params: URLSearchParams): string =>
  [...params.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

/** Las cabeceras a firmar, en minúsculas y ordenadas, con `host` siempre. */
function canonicalHeaders(url: URL, headers: Readonly<Record<string, string>>) {
  const all = new Map<string, string>([['host', url.host]]);
  for (const [name, value] of Object.entries(headers)) {
    all.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  const names = [...all.keys()].sort();
  return {
    block: names.map((name) => `${name}:${all.get(name)}\n`).join(''),
    signed: names.join(';'),
  };
}

async function signature(
  credentials: Credentials,
  day: string,
  stringToSign: string,
): Promise<string> {
  const service = credentials.service ?? 's3';
  const kDate = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), day);
  const kRegion = await hmac(kDate, credentials.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  return hex(await hmac(kSigning, stringToSign));
}

interface Canonical {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly date: Date;
}

async function sign(credentials: Credentials, request: Canonical) {
  const { stamp, day } = amzDates(request.date);
  const scope = `${day}/${credentials.region}/${credentials.service ?? 's3'}/aws4_request`;
  const { block, signed } = canonicalHeaders(request.url, request.headers);
  const canonical = [
    request.method,
    // El camino ya viene codificado en la URL (ver `objectUrl`); no se codifica dos veces.
    request.url.pathname,
    canonicalQuery(request.url.searchParams),
    block,
    signed,
    request.payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonical)].join('\n');
  return { signed, scope, stamp, signature: await signature(credentials, day, stringToSign) };
}

/**
 * Firma con la cabecera `Authorization`. `headers` se firman todas; se añaden `x-amz-date` y
 * `x-amz-content-sha256`. Devuelve las cabeceras que hay que enviar.
 */
export async function signRequest(
  credentials: Credentials,
  request: {
    readonly method: string;
    readonly url: URL;
    readonly headers?: Readonly<Record<string, string>>;
    readonly payloadHash: string;
    readonly date: Date;
  },
): Promise<Record<string, string>> {
  const { stamp } = amzDates(request.date);
  const headers = {
    ...request.headers,
    'x-amz-content-sha256': request.payloadHash,
    'x-amz-date': stamp,
  };
  const result = await sign(credentials, { ...request, headers });
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${result.scope}, ` +
      `SignedHeaders=${result.signed}, Signature=${result.signature}`,
  };
}

/**
 * Una URL prefirmada: la autenticación va en la consulta y vale `expiresInSeconds`. Quien la use
 * tiene que mandar exactamente las `headers` firmadas (p. ej. el `Content-Type`).
 */
export async function presignUrl(
  credentials: Credentials,
  request: {
    readonly method: string;
    readonly url: URL;
    readonly headers?: Readonly<Record<string, string>>;
    readonly expiresInSeconds: number;
    readonly date: Date;
  },
): Promise<URL> {
  const { stamp, day } = amzDates(request.date);
  const scope = `${day}/${credentials.region}/${credentials.service ?? 's3'}/aws4_request`;
  const url = new URL(request.url);
  const { signed } = canonicalHeaders(url, request.headers ?? {});
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', stamp);
  url.searchParams.set('X-Amz-Expires', String(request.expiresInSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', signed);
  const result = await sign(credentials, {
    method: request.method,
    url,
    headers: request.headers ?? {},
    payloadHash: UNSIGNED_PAYLOAD,
    date: request.date,
  });
  url.searchParams.set('X-Amz-Signature', result.signature);
  return url;
}
