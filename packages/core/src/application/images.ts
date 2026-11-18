import { z } from 'zod';
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_FORMATS,
  IMAGE_PURPOSES,
  detectImage,
  isFavicon,
  ownerTypeOf,
  type DetectedImage,
  type ImagePurpose,
  type ImageRecord,
} from '../domain/image.js';
import type { Actor } from '../domain/role.js';
import type { AssignmentScope } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { ImageStore, ObjectStorage, SignedUpload } from '../ports/images.js';
import type { UserAdmin } from '../ports/identity.js';
import type { AxedaStores } from '../ports/persistence.js';
import { auditDenials, writeAudit, type AuditDraft } from './audit.js';
import { deleteQuietly } from './image-objects.js';
import { lockUsers, type Services } from './services.js';
import { parseInput } from './tenant-input.js';
import type { OnTenant, TenantEntity } from './tenants.js';
import { authorizeOnUser } from './users.js';

export interface ImageUploadInput {
  readonly purpose: ImagePurpose;
  /** El id de la compañía, negocio, sede o usuario. */
  readonly targetId: string;
  /** `image/png`, `image/jpeg` o `image/webp`. */
  readonly contentType: string;
  /** Bytes del archivo que se va a subir. */
  readonly size: number;
}

/** Lo que necesita el navegador para subir el archivo, y el id para completarlo después. */
export interface ImageUploadTicket extends SignedUpload {
  readonly uploadId: string;
  readonly expiresAt: Date;
}

export interface ImageTarget {
  readonly purpose: ImagePurpose;
  readonly targetId: string;
}

export interface ImageResult extends ImageTarget {
  /** La URL pública de la imagen, o `null` si se quitó. */
  readonly url: string | null;
}

export interface ImageService {
  /** Paso 1: comprueba el permiso, el tipo y el tamaño, y firma la subida. */
  createUpload(actor: Actor, input: ImageUploadInput): Promise<ImageUploadTicket>;
  /** Paso 3, tras subir: comprueba el archivo de verdad y lo pone en la entidad. */
  completeUpload(actor: Actor, uploadId: string): Promise<ImageResult>;
  remove(actor: Actor, target: ImageTarget): Promise<ImageResult>;
  /**
   * Borra la foto de perfil de un usuario que ya no existe (para el gancho de borrado del sistema
   * de identidad). Devuelve cuántas imágenes borró.
   */
  forgetUser(userId: string): Promise<number>;
}

/** Las imágenes no cambian nunca (cada versión tiene su clave): se pueden guardar en caché un año. */
const CACHE_FOREVER = 'public, max-age=31536000, immutable';
/** Por encima de esto ni se intenta procesar: protege de las «bombas» de descompresión. */
const MAX_INPUT_PIXELS = 50_000_000;
const BATCH = 100;

const randomName = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

const fieldOf = (purpose: ImagePurpose): 'logoUrl' | 'faviconUrl' =>
  isFavicon(purpose) ? 'faviconUrl' : 'logoUrl';

const rejectImage = (reason: string, message: string): AxedaError =>
  new AxedaError('AXEDA_IMAGE_INVALID', message, { details: { reason } });

/** Una sola respuesta para una subida que no existe, no es tuya, ya se usó o caducó. */
const invalidUpload = (): AxedaError =>
  new AxedaError('AXEDA_UPLOAD_INVALID', 'The upload is invalid or has expired.');

const id = z.string().min(1).max(255);

function uploadSchema(maxBytes: number) {
  return z.strictObject({
    purpose: z.enum(IMAGE_PURPOSES),
    targetId: id,
    contentType: z.enum(IMAGE_CONTENT_TYPES),
    size: z.number().int().min(1).max(maxBytes),
  });
}

const targetSchema = z.strictObject({ purpose: z.enum(IMAGE_PURPOSES), targetId: id });

/** La compañía y el negocio de una entidad, para poder purgar sus imágenes con ella. */
function ownersOf(tenant: TenantEntity): { companyId: string; businessId: string | null } {
  if (tenant.type === 'company') return { companyId: tenant.entity.id, businessId: null };
  if (tenant.type === 'business') {
    return { companyId: tenant.entity.companyId, businessId: tenant.entity.id };
  }
  return { companyId: tenant.entity.companyId, businessId: tenant.entity.businessId };
}

/** Pone la URL en el campo de la entidad, con su versión (como un `update`). */
async function setTenantUrl(
  stores: AxedaStores,
  tenant: TenantEntity,
  purpose: ImagePurpose,
  url: string | null,
): Promise<void> {
  const changes = { [fieldOf(purpose)]: url };
  const { id: entityId, version } = tenant.entity;
  if (tenant.type === 'company') await stores.companies.update(entityId, version, changes);
  else if (tenant.type === 'business') await stores.businesses.update(entityId, version, changes);
  else await stores.sites.update(entityId, version, changes);
}

/**
 * Sustituye la imagen actual por la nueva dentro de la transacción: primero se borra la anterior y
 * después se cierra la subida (una sola lista por propósito y entidad). Devuelve la anterior.
 */
async function swapCurrent(
  images: ImageStore,
  record: ImageRecord,
  ready: { key: string; contentType: string; size: number; width: number; height: number },
): Promise<ImageRecord | null> {
  const previous = await images.findCurrent(record.purpose, record.targetId);
  if (previous !== null && previous.id !== record.id) await images.delete(previous.id);
  if ((await images.markReady(record.id, ready)) === null) throw invalidUpload();
  return previous;
}

export function createImageService(services: Services, onTenant: OnTenant): ImageService {
  const { persistence, options } = services;
  const limits = options.images;

  function storage(): ObjectStorage {
    if (services.storage === undefined) {
      throw new AxedaError(
        'AXEDA_FEATURE_DISABLED',
        'Images are disabled: configure an object storage (storage).',
      );
    }
    return services.storage;
  }

  function avatars(): UserAdmin & { setImage: NonNullable<UserAdmin['setImage']> } {
    const admin = services.userAdmin;
    if (admin?.setImage === undefined) {
      throw new AxedaError(
        'AXEDA_FEATURE_DISABLED',
        'Profile pictures are disabled: the user administration cannot change them.',
      );
    }
    return admin as UserAdmin & { setImage: NonNullable<UserAdmin['setImage']> };
  }

  const draft = (
    actor: Actor | null,
    action: 'image.set' | 'image.remove',
    target: ImageTarget,
    metadata: Record<string, unknown> = {},
  ): AuditDraft => {
    const type = ownerTypeOf(target.purpose);
    const scope: AssignmentScope | null = type === 'user' ? null : { type, id: target.targetId };
    return {
      actorId: actor?.userId ?? null,
      action,
      targetType: type,
      targetId: target.targetId,
      scope,
      meta: actor ?? undefined,
      metadata: { purpose: target.purpose, ...metadata },
    };
  };

  /** El avatar lo cambia la propia persona, o quien puede administrar a esa persona. */
  async function authorizeAvatar(actor: Actor, userId: string): Promise<void> {
    const admin = avatars();
    if (actor.userId === userId) {
      if ((await admin.get(userId)) === null) {
        throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${userId}" does not exist.`);
      }
      return;
    }
    await authorizeOnUser(services, admin, actor, userId);
  }

  async function newUpload(
    actor: Actor,
    input: z.infer<ReturnType<typeof uploadSchema>>,
    owners: { companyId: string | null; businessId: string | null },
    stores: AxedaStores,
  ): Promise<ImageRecord> {
    const now = services.clock.now();
    if ((await stores.images.countPendingBy(actor.userId, now)) >= limits.maxPendingPerUser) {
      throw new AxedaError(
        'AXEDA_LIMIT_EXCEEDED',
        `You cannot have more than ${limits.maxPendingPerUser} uploads in progress.`,
      );
    }
    return stores.images.createUpload({
      purpose: input.purpose,
      targetId: input.targetId,
      ...owners,
      uploadKey: `uploads/${randomName()}`,
      contentType: input.contentType,
      size: input.size,
      uploadedBy: actor.userId,
      expiresAt: new Date(now.getTime() + limits.uploadTtlMinutes * 60_000),
    });
  }

  /** La subida pendiente de quien la pidió y aún vigente. */
  async function loadPending(actor: Actor, uploadId: unknown): Promise<ImageRecord> {
    if (typeof uploadId !== 'string' || uploadId.length === 0 || uploadId.length > 255) {
      throw invalidUpload();
    }
    const record = await persistence.images.get(uploadId);
    if (
      record === null ||
      record.status !== 'pending' ||
      record.uploadedBy !== actor.userId ||
      record.expiresAt <= services.clock.now()
    ) {
      throw invalidUpload();
    }
    return record;
  }

  /** Descarta una subida que no vale: su objeto y su registro. */
  async function discard(record: ImageRecord, error: AxedaError): Promise<never> {
    await deleteQuietly(storage(), [record.uploadKey]);
    await persistence.images.delete(record.id);
    throw error;
  }

  /** Lee lo subido con tope, lo identifica por sus bytes y lo recodifica si hay procesador. */
  async function inspect(
    record: ImageRecord,
  ): Promise<{ bytes: Uint8Array; image: DetectedImage }> {
    const read = await storage().read(record.uploadKey, limits.maxBytes);
    if (read === null) {
      throw new AxedaError('AXEDA_UPLOAD_INVALID', 'Nothing has been uploaded yet.', {
        details: { reason: 'not_uploaded' },
      });
    }
    if (read === 'too_large') {
      return discard(
        record,
        rejectImage('too_large', `The image exceeds ${limits.maxBytes} bytes.`),
      );
    }
    const found = detectImage(read);
    if (found === null || IMAGE_FORMATS[found.format].contentType !== record.contentType) {
      return discard(
        record,
        rejectImage('not_an_image', `The file is not a ${record.contentType} image.`),
      );
    }
    const maxDimension = isFavicon(record.purpose)
      ? limits.faviconMaxDimension
      : limits.maxDimension;
    return processed(record, read, found, maxDimension);
  }

  async function processed(
    record: ImageRecord,
    bytes: Uint8Array,
    found: DetectedImage,
    maxDimension: number,
  ): Promise<{ bytes: Uint8Array; image: DetectedImage }> {
    const tooBig = (image: DetectedImage) =>
      image.width > maxDimension || image.height > maxDimension;
    const processor = services.imageProcessor;
    if (
      found.width * found.height > MAX_INPUT_PIXELS ||
      (processor === undefined && tooBig(found))
    ) {
      return discard(
        record,
        rejectImage(
          'too_many_pixels',
          `The image must be at most ${maxDimension} pixels per side.`,
        ),
      );
    }
    if (processor === undefined) return { bytes, image: found };
    const output = await processor.process(bytes, { format: found.format, maxDimension });
    const image = detectImage(output.bytes);
    if (image === null || tooBig(image) || output.bytes.length > limits.maxBytes) {
      return discard(record, rejectImage('processing_failed', 'The image could not be processed.'));
    }
    return { bytes: output.bytes, image };
  }

  /** Guarda la imagen final y la pone en su sitio. Devuelve la URL y la clave anterior. */
  async function commit(
    actor: Actor,
    record: ImageRecord,
    key: string,
    ready: { key: string; contentType: string; size: number; width: number; height: number },
  ): Promise<{ url: string; previousKey: string | null }> {
    const url = storage().publicUrl(key);
    const type = ownerTypeOf(record.purpose);
    const audit = (stores: AxedaStores) =>
      writeAudit(stores, draft(actor, 'image.set', record, { size: ready.size }), 'success');

    if (type !== 'user') {
      const previous = await onTenant(actor, type, record.targetId, 'image.set', async (s, t) => {
        const replaced = await swapCurrent(s.images, record, ready);
        await setTenantUrl(s, t, record.purpose, url);
        await audit(s);
        return replaced;
      });
      return { url, previousKey: previous?.key ?? null };
    }

    const previous = await auditDenials(
      persistence,
      draft(actor, 'image.set', record),
      async () => {
        await authorizeAvatar(actor, record.targetId);
        return persistence.transaction(async (stores) => {
          await lockUsers(stores, [record.targetId]);
          const replaced = await swapCurrent(stores.images, record, ready);
          await audit(stores);
          return replaced;
        });
      },
    );
    // Fuera de la transacción: la tabla de usuarios es del sistema de identidad. Si esto falla, la
    // foto anterior sigue en pie (su objeto no se ha borrado).
    await avatars().setImage(record.targetId, url);
    return { url, previousKey: previous?.key ?? null };
  }

  return {
    async createUpload(actor, input) {
      await services.ready();
      const store = storage();
      const parsed = parseInput(uploadSchema(limits.maxBytes), input);
      const type = ownerTypeOf(parsed.purpose);
      const record =
        type === 'user'
          ? await auditDenials(persistence, draft(actor, 'image.set', parsed), async () => {
              await authorizeAvatar(actor, parsed.targetId);
              return persistence.transaction((stores) =>
                newUpload(actor, parsed, { companyId: null, businessId: null }, stores),
              );
            })
          : await onTenant(actor, type, parsed.targetId, 'image.set', (stores, tenant) =>
              newUpload(actor, parsed, ownersOf(tenant), stores),
            );

      try {
        const signed = await store.signUpload(record.uploadKey, {
          contentType: parsed.contentType,
          contentLength: parsed.size,
          expiresInSeconds: limits.uploadTtlMinutes * 60,
        });
        return { ...signed, uploadId: record.id, expiresAt: record.expiresAt };
      } catch (error) {
        // Sin URL firmada la subida no sirve: se quita para que no cuente en el límite.
        await persistence.images.delete(record.id);
        throw error;
      }
    },

    async completeUpload(actor, uploadId) {
      await services.ready();
      const store = storage();
      const record = await loadPending(actor, uploadId);
      const { bytes, image } = await inspect(record);
      const format = IMAGE_FORMATS[image.format];
      const key = `images/${randomName()}.${format.extension}`;
      await store.write(key, bytes, {
        contentType: format.contentType,
        cacheControl: CACHE_FOREVER,
      });
      const ready = {
        key,
        contentType: format.contentType,
        size: bytes.length,
        width: image.width,
        height: image.height,
      };
      let done: { url: string; previousKey: string | null };
      try {
        done = await commit(actor, record, key, ready);
      } catch (error) {
        await deleteQuietly(store, [key]);
        throw error;
      }
      await deleteQuietly(store, [record.uploadKey, done.previousKey]);
      return { purpose: record.purpose, targetId: record.targetId, url: done.url };
    },

    async remove(actor, target) {
      await services.ready();
      const parsed = parseInput(targetSchema, target);
      const type = ownerTypeOf(parsed.purpose);
      const removeCurrent = async (stores: AxedaStores) => {
        const current = await stores.images.findCurrent(parsed.purpose, parsed.targetId);
        if (current !== null) await stores.images.delete(current.id);
        await writeAudit(stores, draft(actor, 'image.remove', parsed), 'success');
        return current;
      };
      const current =
        type === 'user'
          ? await auditDenials(persistence, draft(actor, 'image.remove', parsed), async () => {
              await authorizeAvatar(actor, parsed.targetId);
              const removed = await persistence.transaction(removeCurrent);
              await avatars().setImage(parsed.targetId, null);
              return removed;
            })
          : await onTenant(actor, type, parsed.targetId, 'image.remove', async (stores, tenant) => {
              const removed = await removeCurrent(stores);
              await setTenantUrl(stores, tenant, parsed.purpose, null);
              return removed;
            });
      if (current?.key && services.storage !== undefined) {
        await deleteQuietly(services.storage, [current.key]);
      }
      return { ...parsed, url: null };
    },

    async forgetUser(userId) {
      await services.ready();
      const removed = await persistence.images.deleteForUser(userId);
      if (services.storage !== undefined) {
        await deleteQuietly(
          services.storage,
          removed.flatMap((image) => [image.key, image.uploadKey]),
        );
      }
      return removed.length;
    },
  };
}

/**
 * Borra las subidas que nadie completó a tiempo (su objeto y su registro). Para `purgeDeleted()`.
 * Devuelve cuántas borró.
 */
export async function sweepExpiredUploads(services: Services): Promise<number> {
  let removed = 0;
  for (;;) {
    const expired = await services.persistence.images.listExpiredUploads(
      services.clock.now(),
      BATCH,
    );
    if (expired.length === 0) return removed;
    if (services.storage !== undefined) {
      await deleteQuietly(
        services.storage,
        expired.map((image) => image.uploadKey),
      );
    }
    for (const image of expired) {
      if (await services.persistence.images.delete(image.id)) removed += 1;
    }
  }
}
