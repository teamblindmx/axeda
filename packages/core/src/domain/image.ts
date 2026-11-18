/**
 * Imágenes que Axeda guarda: logos y favicons de compañías, negocios y sedes, y la foto de perfil.
 * El formato se decide **por los bytes**, nunca por lo que declara quien sube el archivo.
 */

/** Para qué es una imagen: el tipo de entidad y el campo que ocupa. */
export const IMAGE_PURPOSES = Object.freeze([
  'company.logo',
  'company.favicon',
  'business.logo',
  'business.favicon',
  'site.logo',
  'site.favicon',
  'user.avatar',
] as const);

export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

/** El tipo de entidad de un propósito. */
export type ImageOwnerType = 'company' | 'business' | 'site' | 'user';

export const ownerTypeOf = (purpose: ImagePurpose): ImageOwnerType =>
  purpose.slice(0, purpose.indexOf('.')) as ImageOwnerType;

export const isFavicon = (purpose: ImagePurpose): boolean => purpose.endsWith('.favicon');

/** Formatos aceptados. Sin SVG (puede llevar scripts) ni GIF ni ICO. */
export const IMAGE_FORMATS = Object.freeze({
  png: { contentType: 'image/png', extension: 'png' },
  jpeg: { contentType: 'image/jpeg', extension: 'jpg' },
  webp: { contentType: 'image/webp', extension: 'webp' },
} as const);

export type ImageFormat = keyof typeof IMAGE_FORMATS;

/** Los tipos aceptados, como lista cerrada (para validar y para los tipos del cliente). */
export const IMAGE_CONTENT_TYPES = Object.freeze([
  IMAGE_FORMATS.png.contentType,
  IMAGE_FORMATS.jpeg.contentType,
  IMAGE_FORMATS.webp.contentType,
] as const);

export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

export const formatOfContentType = (contentType: string): ImageFormat | null => {
  const entry = Object.entries(IMAGE_FORMATS).find(([, f]) => f.contentType === contentType);
  return entry === undefined ? null : (entry[0] as ImageFormat);
};

export type ImageStatus = 'pending' | 'ready';

/**
 * Una imagen: primero una subida pendiente (`uploadKey`), después la imagen lista (`key`). A quién
 * pertenece se guarda aparte (`companyId`, `businessId`) para poder purgarla con su compañía o su
 * negocio sin consultar nada más.
 */
export interface ImageRecord {
  readonly id: string;
  readonly purpose: ImagePurpose;
  /** El id de la compañía, negocio, sede o usuario. */
  readonly targetId: string;
  /** La compañía de la entidad; `null` en un avatar. */
  readonly companyId: string | null;
  /** El negocio: el propio en `business.*`, el de la sede en `site.*` (si cuelga de uno). */
  readonly businessId: string | null;
  readonly status: ImageStatus;
  /** Dónde se sube el archivo. Solo tiene sentido mientras está pendiente. */
  readonly uploadKey: string;
  /** Dónde queda la imagen lista; `null` mientras está pendiente. */
  readonly key: string | null;
  /** Declarado al pedir la subida y, una vez lista, el real. */
  readonly contentType: string;
  /** Bytes: declarados al pedir la subida y, una vez lista, los reales. */
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly uploadedBy: string;
  readonly createdAt: Date;
  /** Hasta cuándo se puede completar la subida. */
  readonly expiresAt: Date;
}

export interface DetectedImage {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  prefix.every((value, index) => bytes[at + index] === value);

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 0x10000 + u16be(b, at + 2);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function detectPng(bytes: Uint8Array): DetectedImage | null {
  // La primera parte es siempre IHDR: longitud (4), tipo (4), ancho (4), alto (4).
  if (bytes.length < 24 || !startsWith(bytes, PNG_SIGNATURE)) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  return { format: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** Marcadores SOF de JPEG que llevan las dimensiones (todos los C0–CF salvo C4, C8 y CC). */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** Marcadores sin longitud: relleno (FF), TEM (01) y RST0–RST7. */
const standaloneLength = (marker: number): number | null => {
  if (marker === 0xff) return 1;
  if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return 2;
  return null;
};

/**
 * Un paso por los segmentos de un JPEG: la imagen si es el SOF, la posición del siguiente segmento,
 * o `null` si el archivo no sigue el formato.
 */
function jpegStep(bytes: Uint8Array, at: number): DetectedImage | number | null {
  if (bytes[at] !== 0xff) return null;
  const marker = bytes[at + 1] ?? 0;
  const skip = standaloneLength(marker);
  if (skip !== null) return at + skip;
  // Fin de la imagen o inicio de los datos sin haber visto el SOF.
  if (marker === 0xd9 || marker === 0xda) return null;
  if (isStartOfFrame(marker)) {
    return { format: 'jpeg', width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
  }
  const length = u16be(bytes, at + 2);
  return length < 2 ? null : at + 2 + length;
}

function detectJpeg(bytes: Uint8Array): DetectedImage | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    const step = jpegStep(bytes, at);
    if (step === null || typeof step === 'object') return step;
    at = step;
  }
  return null;
}

function detectWebp(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null;
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    // Fotograma clave: 3 bytes de etiqueta y el código de inicio 9d 01 2a.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return { format: 'webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = u16le(bytes, 21) + u16le(bytes, 23) * 0x10000;
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { format: 'webp', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return null;
}

/**
 * El formato y las dimensiones de una imagen, leídos de sus primeros bytes. `null` si no es un
 * PNG, JPEG o WebP reconocible o si declara dimensiones nulas.
 */
export function detectImage(bytes: Uint8Array): DetectedImage | null {
  const found = detectPng(bytes) ?? detectJpeg(bytes) ?? detectWebp(bytes);
  if (found === null || found.width <= 0 || found.height <= 0) return null;
  return found;
}
