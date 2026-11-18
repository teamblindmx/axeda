import type { ObjectStorage, SignedUpload } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';

export interface StorageUnderTest {
  readonly storage: ObjectStorage;
  /**
   * Lo que hace el navegador con una subida firmada: mandar los bytes con su método, su URL y sus
   * cabeceras. Debe lanzar si el almacén la rechaza.
   */
  upload(signed: SignedUpload, bytes: Uint8Array): Promise<void>;
}

const bytesOf = (size: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length: size }, (_, index) => (index * seed) % 251);

/** Una clave nueva en cada prueba: el almacén real se comparte entre ellas. */
const freshKey = (prefix: string) =>
  `${prefix}/${globalThis.crypto.randomUUID().replace(/-/g, '')}`;

/**
 * Pruebas de contrato de un almacén de objetos (`ObjectStorage`): las mismas para el de memoria y
 * para uno real (R2, S3, MinIO). `factory` se llama una vez por prueba.
 */
export function runObjectStorageContract(name: string, factory: () => Promise<StorageUnderTest>) {
  describe(`ObjectStorage contract: ${name}`, () => {
    it('accepts a signed upload and gives back the same bytes and type', async () => {
      const { storage, upload } = await factory();
      const key = freshKey('uploads');
      const bytes = bytesOf(3000);
      const signed = await storage.signUpload(key, {
        contentType: 'image/png',
        contentLength: bytes.length,
        expiresInSeconds: 300,
      });
      expect(signed.method).toBe('PUT');
      expect(signed.headers['content-type']).toBe('image/png');
      await upload(signed, bytes);
      expect(await storage.head(key)).toEqual({ size: 3000, contentType: 'image/png' });
      expect(await storage.read(key, 10_000)).toEqual(bytes);
      await storage.delete(key);
    });

    it('refuses a signed upload sent with another content type', async () => {
      const { storage, upload } = await factory();
      const key = freshKey('uploads');
      const signed = await storage.signUpload(key, {
        contentType: 'image/png',
        contentLength: 10,
        expiresInSeconds: 300,
      });
      await expect(
        upload(
          { ...signed, headers: { ...signed.headers, 'content-type': 'text/html' } },
          bytesOf(10),
        ),
      ).rejects.toThrow();
      expect(await storage.head(key)).toBeNull();
    });

    it('reads up to the cap, and says too large one byte past it', async () => {
      const { storage } = await factory();
      const key = freshKey('images');
      const bytes = bytesOf(5000, 13);
      await storage.write(key, bytes, { contentType: 'image/webp', cacheControl: 'no-store' });
      expect(await storage.read(key, 5000)).toEqual(bytes);
      expect(await storage.read(key, 4999)).toBe('too_large');
      expect(await storage.read(key, 100)).toBe('too_large');
      await storage.delete(key);
    });

    it('writes, overwrites and deletes; what does not exist is null', async () => {
      const { storage } = await factory();
      const key = freshKey('images');
      expect(await storage.head(key)).toBeNull();
      expect(await storage.read(key, 100)).toBeNull();
      await storage.write(key, bytesOf(10), { contentType: 'image/png', cacheControl: 'no-store' });
      await storage.write(key, bytesOf(20, 3), {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      expect(await storage.head(key)).toEqual({ size: 20, contentType: 'image/jpeg' });
      expect(await storage.read(key, 100)).toEqual(bytesOf(20, 3));
      await storage.delete(key);
      expect(await storage.head(key)).toBeNull();
      // Borrar otra vez no es un error.
      await storage.delete(key);
    });

    it('gives each key its own public URL', async () => {
      const { storage } = await factory();
      const first = storage.publicUrl('images/aaaa.png');
      const second = storage.publicUrl('images/bbbb.png');
      expect(first).toMatch(/^https?:\/\/.+\/images\/aaaa\.png$/);
      expect(second).not.toBe(first);
    });
  });
}
