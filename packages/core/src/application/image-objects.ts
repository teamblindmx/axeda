import type { ImageRecord } from '../domain/image.js';
import type { ObjectStorage } from '../ports/images.js';
import type { Services } from './services.js';

/** Borra objetos sin dejar que un fallo del almacén tape el resultado: quedan para la limpieza. */
export async function deleteQuietly(
  storage: ObjectStorage,
  keys: readonly (string | null)[],
): Promise<void> {
  await Promise.all(
    keys.flatMap((key) => (key === null ? [] : [storage.delete(key).catch(() => undefined)])),
  );
}

/** Borra los objetos de imágenes cuyos registros ya se borraron (p. ej. al purgar). */
export async function deleteImageObjects(
  services: Services,
  images: readonly ImageRecord[],
): Promise<void> {
  if (services.storage === undefined || images.length === 0) return;
  await deleteQuietly(
    services.storage,
    images.flatMap((image) => [image.key, image.uploadKey]),
  );
}
