import { describe, expect, it } from 'vitest';
import { detectImage } from '../src/index.js';
import { jpeg, png, svg, webpExtended, webpLossless, webpLossy } from './image-bytes.js';

describe('detecting an image by its bytes', () => {
  it('reads the format and the size of PNG, JPEG and the three kinds of WebP', () => {
    expect(detectImage(png(640, 480))).toEqual({ format: 'png', width: 640, height: 480 });
    expect(detectImage(jpeg(1920, 1080))).toEqual({ format: 'jpeg', width: 1920, height: 1080 });
    expect(detectImage(jpeg(300, 200, 64, 0xc2))).toEqual({
      format: 'jpeg',
      width: 300,
      height: 200,
    });
    expect(detectImage(webpLossy(800, 600))).toEqual({ format: 'webp', width: 800, height: 600 });
    expect(detectImage(webpLossless(16, 9))).toEqual({ format: 'webp', width: 16, height: 9 });
    expect(detectImage(webpExtended(5000, 3000))).toEqual({
      format: 'webp',
      width: 5000,
      height: 3000,
    });
  });

  it('refuses SVG, text, empty, truncated and zero-sized files', () => {
    expect(detectImage(svg())).toBeNull();
    expect(detectImage(new TextEncoder().encode('<html><body>hi</body></html>'))).toBeNull();
    expect(detectImage(new Uint8Array())).toBeNull();
    expect(detectImage(png(10, 10).subarray(0, 20))).toBeNull();
    expect(detectImage(png(0, 10))).toBeNull();
    expect(detectImage(jpeg(10, 0))).toBeNull();
  });

  it('does not take a JPEG Huffman table (C4) or arithmetic table (CC) for the frame size', () => {
    const fake = jpeg(100, 100, 64, 0xc4);
    expect(detectImage(fake)).toBeNull();
    expect(detectImage(jpeg(100, 100, 64, 0xcc))).toBeNull();
  });

  it('never reads past the end of a malformed JPEG', () => {
    // Segmentos con longitudes absurdas o cortadas: termina sin lanzar.
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
    expect(detectImage(broken)).toBeNull();
    const zeroLength = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(detectImage(zeroLength)).toBeNull();
  });
});
