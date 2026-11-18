import { isAxedaError } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';
import { sharpImageProcessor, type SharpFactory, type SharpPipeline } from '../src/index.js';

/** Un `sharp` de mentira que apunta lo que se le pide. */
function fakeSharp(output = new Uint8Array([1, 2, 3])) {
  const calls: unknown[][] = [];
  const pipeline: SharpPipeline = {
    rotate: () => (calls.push(['rotate']), pipeline),
    resize: (options) => (calls.push(['resize', options]), pipeline),
    png: (options) => (calls.push(['png', options]), pipeline),
    jpeg: (options) => (calls.push(['jpeg', options]), pipeline),
    webp: (options) => (calls.push(['webp', options]), pipeline),
    toBuffer: async () => output,
  };
  const factory: SharpFactory = (input, options) => {
    calls.push(['sharp', input.length, options]);
    return pipeline;
  };
  return { factory, calls };
}

describe('the sharp image processor', () => {
  it('fixes the orientation, shrinks to fit and re-encodes in the same format', async () => {
    const { factory, calls } = fakeSharp();
    const processor = sharpImageProcessor({ load: async () => factory });
    const result = await processor.process(new Uint8Array(10), {
      format: 'webp',
      maxDimension: 512,
    });
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), format: 'webp' });
    expect(calls).toEqual([
      ['sharp', 10, { limitInputPixels: 50_000_000, failOn: 'error', animated: false }],
      ['rotate'],
      ['resize', { width: 512, height: 512, fit: 'inside', withoutEnlargement: true }],
      ['webp', { quality: 82 }],
    ]);
  });

  it('keeps PNG lossless and JPEG at the chosen quality', async () => {
    const { factory, calls } = fakeSharp();
    const processor = sharpImageProcessor({ quality: 70, load: async () => factory });
    await processor.process(new Uint8Array(1), { format: 'png', maxDimension: 64 });
    await processor.process(new Uint8Array(1), { format: 'jpeg', maxDimension: 64 });
    expect(calls.filter(([name]) => name === 'png' || name === 'jpeg')).toEqual([
      ['png', { compressionLevel: 9 }],
      ['jpeg', { quality: 70, mozjpeg: true }],
    ]);
  });

  it('explains how to install sharp when it is missing, and tries again next time', async () => {
    let attempts = 0;
    const processor = sharpImageProcessor({
      load: async () => {
        attempts += 1;
        throw new Error("Cannot find package 'sharp'");
      },
    });
    for (let i = 0; i < 2; i++) {
      const error = await processor
        .process(new Uint8Array(1), { format: 'png', maxDimension: 64 })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(isAxedaError(error, 'AXEDA_INVALID_CONFIG')).toBe(true);
      expect((error as Error).message).toContain('npm install sharp');
    }
    expect(attempts).toBe(2);
  });

  it('refuses a misspelled option', () => {
    expect(() => sharpImageProcessor({ qualty: 80 } as never)).toThrow(/Did you mean "quality"/);
  });

  it('refuses a quality out of range', () => {
    for (const quality of [0, 101, 50.5]) {
      expect(() => sharpImageProcessor({ quality })).toThrow(/quality/);
    }
  });
});
