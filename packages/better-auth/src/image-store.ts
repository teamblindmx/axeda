import {
  AxedaError,
  IMAGE_PURPOSES,
  type ImagePurpose,
  type ImageRecord,
  type ImageStore,
  type NewImageUpload,
} from '@teamblind/axeda-core';
import { isUniqueViolation } from './errors.js';
import { MODELS } from './schema.js';
import { byId, MAX_ROWS, type Adapter } from './shared.js';

interface ImageRow {
  id: string;
  purpose: string;
  targetId: string;
  companyId?: string | null;
  businessId?: string | null;
  status: string;
  uploadKey: string;
  objectKey?: string | null;
  contentType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  uploadedBy: string;
  expiresAt: Date;
  createdAt: Date;
  slot: string;
  consumed: number;
}

const model = MODELS.image;

/** Un propósito desconocido en la base de datos es un dato corrupto: no se adivina. */
function purposeOf(row: ImageRow): ImagePurpose {
  if ((IMAGE_PURPOSES as readonly string[]).includes(row.purpose)) {
    return row.purpose as ImagePurpose;
  }
  throw new AxedaError('AXEDA_DATA_CORRUPT', `Image "${row.id}" has an unknown purpose.`);
}

const toImage = (row: ImageRow): ImageRecord => ({
  id: row.id,
  purpose: purposeOf(row),
  targetId: row.targetId,
  companyId: row.companyId ?? null,
  businessId: row.businessId ?? null,
  status: row.status === 'ready' ? 'ready' : 'pending',
  uploadKey: row.uploadKey,
  key: row.objectKey ?? null,
  contentType: row.contentType,
  size: row.size,
  width: row.width ?? null,
  height: row.height ?? null,
  uploadedBy: row.uploadedBy,
  expiresAt: new Date(row.expiresAt),
  createdAt: new Date(row.createdAt),
});

const currentSlot = (purpose: string, targetId: string): string => `current:${purpose}:${targetId}`;

export function createImageStore(adapter: Adapter, now: () => Date): ImageStore {
  const findAll = async (
    where: { field: string; value: string | string[] | Date; operator?: 'in' | 'lte' }[],
  ) => (await adapter.findMany<ImageRow>({ model, where, limit: MAX_ROWS })).map(toImage);

  /** Borra esas imágenes y las devuelve. */
  const take = async (images: readonly ImageRecord[]): Promise<readonly ImageRecord[]> => {
    if (images.length > 0) {
      await adapter.deleteMany({
        model,
        where: [{ field: 'id', operator: 'in', value: images.map((image) => image.id) }],
      });
    }
    return images;
  };

  return {
    async get(id) {
      const row = await adapter.findOne<ImageRow>({ model, where: byId(id) });
      return row === null ? null : toImage(row);
    },

    async createUpload(input: NewImageUpload) {
      const row = await adapter.create<Omit<ImageRow, 'id'>, ImageRow>({
        model,
        data: {
          purpose: input.purpose,
          targetId: input.targetId,
          companyId: input.companyId,
          businessId: input.businessId,
          status: 'pending',
          uploadKey: input.uploadKey,
          objectKey: null,
          contentType: input.contentType,
          size: input.size,
          width: null,
          height: null,
          uploadedBy: input.uploadedBy,
          expiresAt: input.expiresAt,
          createdAt: now(),
          // La clave de subida es aleatoria: sirve de hueco único mientras está pendiente.
          slot: `pending:${input.uploadKey}`,
          consumed: 0,
        },
      });
      return toImage(row);
    },

    async countPendingBy(userId, at) {
      return adapter.count({
        model,
        where: [
          { field: 'uploadedBy', value: userId },
          { field: 'status', value: 'pending' },
          { field: 'expiresAt', operator: 'gt', value: at },
        ],
      });
    },

    async findCurrent(purpose, targetId) {
      const row = await adapter.findOne<ImageRow>({
        model,
        where: [{ field: 'slot', value: currentSlot(purpose, targetId) }],
      });
      return row === null ? null : toImage(row);
    },

    async markReady(id, image) {
      const pending = await adapter.findOne<ImageRow>({ model, where: byId(id) });
      if (pending === null) return null;
      try {
        // Solo un completado pasa `consumed` de 0 a 1; el índice único de `slot` impide dos listas.
        const updated = await adapter.incrementOne<ImageRow>({
          model,
          where: [
            { field: 'id', value: id },
            { field: 'consumed', value: 0 },
          ],
          increment: { consumed: 1 },
          set: {
            status: 'ready',
            objectKey: image.key,
            contentType: image.contentType,
            size: image.size,
            width: image.width,
            height: image.height,
            slot: currentSlot(pending.purpose, pending.targetId),
          },
        });
        return updated === null ? null : toImage(updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AxedaError(
            'AXEDA_VERSION_CONFLICT',
            'Another image was set at the same time; try again.',
          );
        }
        throw error;
      }
    },

    async delete(id) {
      const removed = await adapter.deleteMany({ model, where: byId(id) });
      return removed > 0;
    },

    async listExpiredUploads(before, limit) {
      const rows = await adapter.findMany<ImageRow>({
        model,
        where: [
          { field: 'status', value: 'pending' },
          { field: 'expiresAt', operator: 'lte', value: before },
        ],
        sortBy: { field: 'id', direction: 'asc' },
        limit,
      });
      return rows.map(toImage);
    },

    async deleteOwnedBy(owners) {
      const groups = await Promise.all([
        owners.companyIds.length === 0
          ? []
          : findAll([{ field: 'companyId', operator: 'in', value: [...owners.companyIds] }]),
        owners.businessIds.length === 0
          ? []
          : findAll([{ field: 'businessId', operator: 'in', value: [...owners.businessIds] }]),
        owners.siteIds.length === 0
          ? []
          : findAll([{ field: 'targetId', operator: 'in', value: [...owners.siteIds] }]),
      ]);
      const [byCompany, byBusiness, bySite] = groups;
      const unique = new Map<string, ImageRecord>();
      // Un avatar nunca sale con una compañía; por id de sede solo cuentan las imágenes de sede.
      for (const image of [...byCompany, ...byBusiness]) {
        if (image.purpose !== 'user.avatar') unique.set(image.id, image);
      }
      for (const image of bySite) {
        if (image.purpose.startsWith('site.')) unique.set(image.id, image);
      }
      return take([...unique.values()]);
    },

    async deleteForUser(userId) {
      const images = await findAll([
        { field: 'purpose', value: 'user.avatar' },
        { field: 'targetId', value: userId },
      ]);
      return take(images);
    },
  };
}
