import {
  AxedaError,
  type ImageRecord,
  type ImageStore,
  type ObjectInfo,
  type ObjectStorage,
  type SignedUpload,
} from '@teamblind/axeda-core';
import type { Run } from './memory-tenants.js';

export interface ImageState {
  images: Map<string, ImageRecord>;
}

const isTenantImage = (image: ImageRecord): boolean => !image.purpose.startsWith('user.');

/** Registro de imágenes en memoria (parte de `createMemoryPersistence`). */
export function createImageStore(
  state: ImageState,
  run: Run,
  now: () => Date,
  nextId: () => string,
): ImageStore {
  const all = () => [...state.images.values()];
  const current = (purpose: string, targetId: string) =>
    all().find(
      (image) =>
        image.status === 'ready' && image.purpose === purpose && image.targetId === targetId,
    ) ?? null;
  const take = (doomed: readonly ImageRecord[]) => {
    for (const image of doomed) state.images.delete(image.id);
    return doomed;
  };

  return {
    get: (id) => run(async () => state.images.get(id) ?? null),
    createUpload: (input) =>
      run(async () => {
        const record: ImageRecord = {
          id: nextId(),
          purpose: input.purpose,
          targetId: input.targetId,
          companyId: input.companyId,
          businessId: input.businessId,
          status: 'pending',
          uploadKey: input.uploadKey,
          key: null,
          contentType: input.contentType,
          size: input.size,
          width: null,
          height: null,
          uploadedBy: input.uploadedBy,
          createdAt: now(),
          expiresAt: input.expiresAt,
        };
        state.images.set(record.id, record);
        return record;
      }),
    countPendingBy: (userId, at) =>
      run(
        async () =>
          all().filter(
            (image) =>
              image.status === 'pending' && image.uploadedBy === userId && image.expiresAt > at,
          ).length,
      ),
    findCurrent: (purpose, targetId) => run(async () => current(purpose, targetId)),
    markReady: (id, image) =>
      run(async () => {
        const record = state.images.get(id);
        if (record === undefined || record.status !== 'pending') return null;
        if (current(record.purpose, record.targetId) !== null) {
          throw new AxedaError(
            'AXEDA_VERSION_CONFLICT',
            'Another image was set at the same time; try again.',
          );
        }
        const ready: ImageRecord = { ...record, ...image, status: 'ready' };
        state.images.set(id, ready);
        return ready;
      }),
    delete: (id) => run(async () => state.images.delete(id)),
    listExpiredUploads: (before, limit) =>
      run(async () =>
        all()
          .filter((image) => image.status === 'pending' && image.expiresAt <= before)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit),
      ),
    deleteOwnedBy: (owners) =>
      run(async () =>
        take(
          all().filter(
            (image) =>
              isTenantImage(image) &&
              ((image.companyId !== null && owners.companyIds.includes(image.companyId)) ||
                (image.businessId !== null && owners.businessIds.includes(image.businessId)) ||
                (image.purpose.startsWith('site.') && owners.siteIds.includes(image.targetId))),
          ),
        ),
      ),
    deleteForUser: (userId) =>
      run(async () =>
        take(all().filter((image) => image.purpose === 'user.avatar' && image.targetId === userId)),
      ),
  };
}

export interface MemoryStorage extends ObjectStorage {
  /** Simula lo que hace el navegador con la URL firmada: guarda el objeto. */
  upload(signed: SignedUpload, bytes: Uint8Array): Promise<void>;
  /** Pone un objeto tal cual, sin pasar por una subida firmada. */
  put(key: string, bytes: Uint8Array, contentType?: string): void;
  get(key: string): { bytes: Uint8Array; contentType: string; cacheControl: string } | undefined;
  keys(): string[];
}

/**
 * Almacén de objetos en memoria para las pruebas. Las URLs firmadas son `memory://<clave>?sig=…` y
 * solo valen con el `Content-Type` firmado, como en R2.
 */
export function createMemoryStorage(
  options: { readonly publicBaseUrl?: string } = {},
): MemoryStorage {
  const base = options.publicBaseUrl ?? 'https://images.test';
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; cacheControl: string }
  >();
  const signatures = new Map<string, { key: string; contentType: string }>();

  return {
    async signUpload(key, upload) {
      const signature = globalThis.crypto.randomUUID();
      signatures.set(signature, { key, contentType: upload.contentType });
      return {
        url: `memory://${key}?sig=${signature}`,
        method: 'PUT',
        headers: { 'content-type': upload.contentType },
      };
    },
    async upload(signed, bytes) {
      const signature = new URL(signed.url).searchParams.get('sig') ?? '';
      const allowed = signatures.get(signature);
      if (allowed === undefined || signed.headers['content-type'] !== allowed.contentType) {
        throw new Error('403 SignatureDoesNotMatch');
      }
      objects.set(allowed.key, { bytes, contentType: allowed.contentType, cacheControl: '' });
    },
    put(key, bytes, contentType = 'application/octet-stream') {
      objects.set(key, { bytes, contentType, cacheControl: '' });
    },
    async head(key): Promise<ObjectInfo | null> {
      const object = objects.get(key);
      return object === undefined
        ? null
        : { size: object.bytes.length, contentType: object.contentType };
    },
    async read(key, maxBytes) {
      const object = objects.get(key);
      if (object === undefined) return null;
      return object.bytes.length > maxBytes ? 'too_large' : object.bytes;
    },
    async write(key, bytes, write) {
      objects.set(key, { bytes, contentType: write.contentType, cacheControl: write.cacheControl });
    },
    async delete(key) {
      objects.delete(key);
    },
    publicUrl: (key) => `${base}/${key}`,
    get: (key) => objects.get(key),
    keys: () => [...objects.keys()].sort(),
  };
}
