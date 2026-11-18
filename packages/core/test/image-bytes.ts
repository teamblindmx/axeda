/** Cabeceras mínimas de imágenes para las pruebas: lo justo para leer formato y dimensiones. */

const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const u16be = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const u24le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const text = (value: string) => [...value].map((char) => char.charCodeAt(0));

/** Relleno para que el archivo tenga el tamaño pedido. */
const padded = (head: number[], size: number) => {
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head);
  return bytes;
};

export function png(width: number, height: number, size = 64): Uint8Array {
  return padded(
    [
      ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      ...u32be(13),
      ...text('IHDR'),
      ...u32be(width),
      ...u32be(height),
      8,
      6,
      0,
      0,
      0,
    ],
    size,
  );
}

/** Un JPEG con un segmento APP0 (JFIF) antes del SOF, como los reales. */
export function jpeg(width: number, height: number, size = 64, sof = 0xc0): Uint8Array {
  return padded(
    [
      ...[0xff, 0xd8],
      ...[0xff, 0xe0, ...u16be(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
      ...[0xff, sof, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3],
    ],
    size,
  );
}

export function webpLossy(width: number, height: number, size = 64): Uint8Array {
  return padded(
    [
      ...text('RIFF'),
      ...[0, 0, 0, 0],
      ...text('WEBP'),
      ...text('VP8 '),
      ...[0, 0, 0, 0],
      ...[0, 0, 0],
      ...[0x9d, 0x01, 0x2a],
      ...u16le(width),
      ...u16le(height),
    ],
    size,
  );
}

export function webpLossless(width: number, height: number, size = 64): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return padded(
    [
      ...text('RIFF'),
      ...[0, 0, 0, 0],
      ...text('WEBP'),
      ...text('VP8L'),
      ...[0, 0, 0, 0],
      0x2f,
      bits & 0xff,
      (bits >>> 8) & 0xff,
      (bits >>> 16) & 0xff,
      (bits >>> 24) & 0xff,
    ],
    size,
  );
}

export function webpExtended(width: number, height: number, size = 64): Uint8Array {
  return padded(
    [
      ...text('RIFF'),
      ...[0, 0, 0, 0],
      ...text('WEBP'),
      ...text('VP8X'),
      ...[10, 0, 0, 0],
      ...[0, 0, 0, 0],
      ...u24le(width - 1),
      ...u24le(height - 1),
    ],
    size,
  );
}

export const svg = (): Uint8Array =>
  new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
