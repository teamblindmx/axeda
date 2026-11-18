import { isAxedaError, type AxedaPersistence, type NewImageUpload } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const LATER = new Date('2026-06-01T12:10:00.000Z');
const EARLIER = new Date('2026-06-01T11:50:00.000Z');

let counter = 0;
const upload = (overrides: Partial<NewImageUpload> = {}): NewImageUpload => ({
  purpose: 'company.logo',
  targetId: 'c1',
  companyId: 'c1',
  businessId: null,
  uploadKey: `uploads/k${(counter += 1)}-${globalThis.crypto.randomUUID()}`,
  contentType: 'image/png',
  size: 1234,
  uploadedBy: 'u1',
  expiresAt: LATER,
  ...overrides,
});

const ready = (key: string) => ({
  key,
  contentType: 'image/webp',
  size: 999,
  width: 640,
  height: 480,
});

/** Pruebas de contrato del registro de imágenes (parte de `runPersistenceContract`). */
export function defineImageContract(database: () => AxedaPersistence): void {
  describe('images', () => {
    it('creates a pending upload and reads it back', async () => {
      const created = await database().images.createUpload(upload());
      expect(created).toMatchObject({
        purpose: 'company.logo',
        targetId: 'c1',
        companyId: 'c1',
        businessId: null,
        status: 'pending',
        key: null,
        contentType: 'image/png',
        size: 1234,
        width: null,
        height: null,
        uploadedBy: 'u1',
      });
      expect(created.expiresAt.getTime()).toBe(LATER.getTime());
      expect(await database().images.get(created.id)).toEqual(created);
      expect(await database().images.get('nope')).toBeNull();
      expect(await database().images.findCurrent('company.logo', 'c1')).toBeNull();
    });

    it('marks an upload ready once, and finds it as the current image', async () => {
      const created = await database().images.createUpload(upload());
      const done = await database().images.markReady(created.id, ready('images/a.webp'));
      expect(done).toMatchObject({
        id: created.id,
        status: 'ready',
        key: 'images/a.webp',
        contentType: 'image/webp',
        size: 999,
        width: 640,
        height: 480,
      });
      expect(await database().images.markReady(created.id, ready('images/b.webp'))).toBeNull();
      expect(await database().images.markReady('nope', ready('images/c.webp'))).toBeNull();
      expect(await database().images.findCurrent('company.logo', 'c1')).toEqual(done);
      expect(await database().images.findCurrent('company.favicon', 'c1')).toBeNull();
    });

    it('lets exactly one of several simultaneous completions of the same upload win', async () => {
      const created = await database().images.createUpload(upload());
      const results = await Promise.allSettled(
        ['x', 'y', 'z'].map((name) =>
          database().images.markReady(created.id, ready(`images/${name}.webp`)),
        ),
      );
      const won = results.filter(
        (result) => result.status === 'fulfilled' && result.value !== null,
      );
      expect(won).toHaveLength(1);
    });

    it('keeps one ready image per purpose and entity: the old one must go first', async () => {
      const first = await database().images.createUpload(upload());
      const second = await database().images.createUpload(upload());
      await database().images.markReady(first.id, ready('images/1.webp'));
      const error = await database()
        .images.markReady(second.id, ready('images/2.webp'))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(isAxedaError(error, 'AXEDA_VERSION_CONFLICT')).toBe(true);
      expect(await database().images.delete(first.id)).toBe(true);
      expect(await database().images.delete(first.id)).toBe(false);
      expect((await database().images.markReady(second.id, ready('images/2.webp')))?.key).toBe(
        'images/2.webp',
      );
    });

    it('counts the open uploads of a person and lists the expired ones', async () => {
      await database().images.createUpload(upload());
      await database().images.createUpload(upload());
      await database().images.createUpload(upload({ expiresAt: EARLIER }));
      await database().images.createUpload(upload({ uploadedBy: 'u2' }));
      const done = await database().images.createUpload(upload({ targetId: 'c2' }));
      await database().images.markReady(done.id, ready('images/done.webp'));
      // La lista ya no cuenta como abierta; la caducada tampoco.
      expect(await database().images.countPendingBy('u1', NOW)).toBe(2);
      const expired = await database().images.listExpiredUploads(NOW, 10);
      expect(expired.map((image) => image.expiresAt.getTime())).toEqual([EARLIER.getTime()]);
      expect(await database().images.listExpiredUploads(new Date('2027-01-01'), 2)).toHaveLength(2);
    });

    it('deletes the images of what is purged, and only those', async () => {
      const images = database().images;
      const companyLogo = await images.createUpload(upload());
      const businessLogo = await images.createUpload(
        upload({ purpose: 'business.logo', targetId: 'b1', businessId: 'b1' }),
      );
      const siteOfBusiness = await images.createUpload(
        upload({ purpose: 'site.logo', targetId: 's1', businessId: 'b1' }),
      );
      const siteOfCompany = await images.createUpload(
        upload({ purpose: 'site.favicon', targetId: 's2' }),
      );
      const otherCompany = await images.createUpload(upload({ targetId: 'c2', companyId: 'c2' }));
      // Un avatar con el mismo id que la sede no es de la sede.
      const avatar = await images.createUpload(
        upload({ purpose: 'user.avatar', targetId: 's2', companyId: null }),
      );

      const byBusiness = await images.deleteOwnedBy({
        companyIds: [],
        businessIds: ['b1'],
        siteIds: [],
      });
      expect(byBusiness.map((image) => image.id).sort()).toEqual(
        [businessLogo.id, siteOfBusiness.id].sort(),
      );
      const bySite = await images.deleteOwnedBy({
        companyIds: [],
        businessIds: [],
        siteIds: ['s2'],
      });
      expect(bySite.map((image) => image.id)).toEqual([siteOfCompany.id]);
      const byCompany = await images.deleteOwnedBy({
        companyIds: ['c1'],
        businessIds: [],
        siteIds: [],
      });
      expect(byCompany.map((image) => image.id)).toEqual([companyLogo.id]);
      expect(await images.get(otherCompany.id)).not.toBeNull();
      expect(await images.get(avatar.id)).not.toBeNull();
      expect(await images.deleteOwnedBy({ companyIds: [], businessIds: [], siteIds: [] })).toEqual(
        [],
      );
    });

    it('deletes the picture of a user', async () => {
      const images = database().images;
      const mine = await images.createUpload(
        upload({ purpose: 'user.avatar', targetId: 'u1', companyId: null }),
      );
      await images.markReady(mine.id, ready('images/me.webp'));
      await images.createUpload(
        upload({ purpose: 'user.avatar', targetId: 'u1', companyId: null }),
      );
      const theirs = await images.createUpload(
        upload({ purpose: 'user.avatar', targetId: 'u2', companyId: null }),
      );
      expect(await images.deleteForUser('u1')).toHaveLength(2);
      expect(await images.findCurrent('user.avatar', 'u1')).toBeNull();
      expect(await images.get(theirs.id)).not.toBeNull();
    });

    it('rolls an image back with the transaction', async () => {
      const created = await database().images.createUpload(upload());
      await database()
        .transaction(async (stores) => {
          await stores.images.markReady(created.id, ready('images/tx.webp'));
          throw new Error('rollback');
        })
        .catch(() => undefined);
      expect((await database().images.get(created.id))?.status).toBe('pending');
    });
  });
}
