import {
  AxedaError,
  rejectUnknownOptions,
  type ImageFormat,
  type ImageProcessor,
} from '@teamblind/axeda-core';

/** Lo que se usa de `sharp`: así el paquete no depende de sus tipos ni lo carga si no se usa. */
export interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): SharpPipeline;
  png(options: { compressionLevel: number }): SharpPipeline;
  jpeg(options: { quality: number; mozjpeg: boolean }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

export type SharpFactory = (
  input: Uint8Array,
  options: { limitInputPixels: number; failOn: 'error'; animated: false },
) => SharpPipeline;

export interface SharpImageProcessorOptions {
  /** Calidad de JPEG y WebP, de 1 a 100. Por omisión 82. */
  readonly quality?: number;
  /** Cómo cargar `sharp`. Por omisión `import('sharp')`; para las pruebas. */
  readonly load?: () => Promise<SharpFactory>;
}

/** Igual que en el núcleo: por encima de esto ni se intenta decodificar. */
const MAX_INPUT_PIXELS = 50_000_000;

async function importSharp(): Promise<SharpFactory> {
  // El nombre va en una variable para que TypeScript no exija `sharp` instalado al compilar.
  const name = 'sharp';
  const module_ = (await import(name)) as { default?: SharpFactory };
  return module_.default ?? (module_ as unknown as SharpFactory);
}

/**
 * Recodifica las imágenes con [sharp](https://sharp.pixelplumbing.com) al completar una subida:
 * aplica la orientación de la cámara y **quita todos los metadatos** (EXIF con la ubicación, ICC, XMP),
 * se queda con el primer fotograma y reduce la imagen si pasa de `maxDimension`. Mantiene el formato.
 *
 * `sharp` es una dependencia _peer_ opcional: instálala tú (`npm install sharp`).
 */
const SHARP_OPTIONS = Object.keys({
  quality: true,
  load: true,
} satisfies Record<keyof SharpImageProcessorOptions, true>);

export function sharpImageProcessor(options: SharpImageProcessorOptions = {}): ImageProcessor {
  rejectUnknownOptions('sharpImageProcessor()', options, SHARP_OPTIONS);
  const quality = options.quality ?? 82;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new AxedaError(
      'AXEDA_INVALID_CONFIG',
      'Invalid image processor options: quality must be a whole number from 1 to 100.',
    );
  }
  let loaded: Promise<SharpFactory> | undefined;
  const load = (): Promise<SharpFactory> =>
    (loaded ??= (options.load ?? importSharp)().catch((cause: unknown) => {
      loaded = undefined;
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        'sharpImageProcessor() needs the "sharp" package: npm install sharp',
        { cause },
      );
    }));

  const encode = (pipeline: SharpPipeline, format: ImageFormat): SharpPipeline => {
    if (format === 'png') return pipeline.png({ compressionLevel: 9 });
    if (format === 'jpeg') return pipeline.jpeg({ quality, mozjpeg: true });
    return pipeline.webp({ quality });
  };

  return {
    async process(bytes, { format, maxDimension }) {
      const sharp = await load();
      // Sin `withMetadata()`: sharp no copia ningún metadato a la salida.
      const pipeline = sharp(bytes, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
        animated: false,
      })
        .rotate()
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        });
      const output = await encode(pipeline, format).toBuffer();
      return { bytes: new Uint8Array(output), format };
    },
  };
}
