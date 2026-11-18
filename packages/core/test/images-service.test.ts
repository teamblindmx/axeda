import { describe, expect, it } from 'vitest';
import {
  isAxedaError,
  type Actor,
  type AxedaErrorCode,
  type ImageProcessor,
  type ImageUploadInput,
} from '../src/index.js';
import { createFixture } from './fixture.js';
import { jpeg, png, svg, webpLossy } from './image-bytes.js';

const DAY = 86_400_000;

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error & { details: Record<string, unknown> };
};

async function world(extra: Parameters<typeof createFixture>[1] = {}) {
  const f = await createFixture(undefined, extra);
  const acme = await f.company('A');
  await f.company('B');
  const shop = await f.business('shop', 'A');
  const north = await f.site('north', 'A', 'shop');
  const hq = await f.site('hq', 'A');
  await f.role('company-admin', ['axeda:company:manage', 'axeda:business:manage']);
  await f.role('site-admin', ['axeda:site:manage']);
  await f.role('reader', ['invoice:read']);
  const boss = f.user('boss');
  await f.give('boss', 'company-admin', { type: 'company', id: 'A' });
  const nobody = f.user('nobody');
  await f.give('nobody', 'reader', { type: 'company', id: 'A' });

  /** Pide la subida, «sube» los bytes como lo haría el navegador y la completa. */
  const upload = async (
    actor: Actor,
    input: Partial<ImageUploadInput>,
    bytes: Uint8Array = png(200, 100),
  ) => {
    const ticket = await f.axeda.images.createUpload(actor, {
      purpose: 'company.logo',
      targetId: 'A',
      contentType: 'image/png',
      size: bytes.length,
      ...input,
    });
    await f.storage.upload(ticket, bytes);
    return ticket;
  };
  const complete = (actor: Actor, uploadId: string) =>
    f.axeda.images.completeUpload(actor, uploadId);
  const setLogo = async (actor: Actor, input: Partial<ImageUploadInput> = {}, bytes?: Uint8Array) =>
    complete(actor, (await upload(actor, input, bytes)).uploadId);
  return { ...f, acme, shop, north, hq, boss, nobody, upload, complete, setLogo };
}

describe('uploading a logo', () => {
  it('signs a direct upload, checks the file and puts its public URL on the company', async () => {
    const w = await world();
    const ticket = await w.upload(w.boss, {});
    expect(ticket).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
    expect(ticket.expiresAt.getTime()).toBe(w.clock.current.getTime() + 10 * 60_000);
    // Antes de completar, la compañía no ha cambiado.
    expect((await w.persistence.companies.get('A'))?.logoUrl).toBeNull();

    const result = await w.complete(w.boss, ticket.uploadId);
    expect(result).toMatchObject({ purpose: 'company.logo', targetId: 'A' });
    expect(result.url).toMatch(/^https:\/\/images\.test\/images\/[0-9a-f]{32}\.png$/);
    const company = await w.persistence.companies.get('A');
    expect(company?.logoUrl).toBe(result.url);
    expect(company?.version).toBe(w.acme.version + 1);

    // Solo queda la imagen final, guardada con su tipo real y para siempre en caché.
    const [key] = w.storage.keys();
    expect(w.storage.keys()).toHaveLength(1);
    expect(w.storage.get(key ?? '')).toMatchObject({
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const events = await w.axeda.listAudit(w.admin, { action: 'image.set' }, { limit: 5 });
    expect(events.items[0]).toMatchObject({
      actorId: 'boss',
      targetType: 'company',
      targetId: 'A',
      outcome: 'success',
      metadata: { purpose: 'company.logo' },
    });
  });

  it('never puts the company or the user in the object keys', async () => {
    const w = await world();
    const ticket = await w.upload(w.boss, {});
    expect(ticket.url).not.toContain('A');
    expect(ticket.url).toMatch(/^memory:\/\/uploads\/[0-9a-f]{32}\?/);
  });

  it('replaces the previous logo and deletes its object', async () => {
    const w = await world();
    const first = await w.setLogo(w.boss);
    const second = await w.setLogo(w.boss, { contentType: 'image/jpeg' }, jpeg(300, 300));
    expect(second.url).not.toBe(first.url);
    expect(second.url).toMatch(/\.jpg$/);
    expect(w.storage.keys()).toEqual([second.url?.replace('https://images.test/', '')]);
    expect((await w.persistence.companies.get('A'))?.logoUrl).toBe(second.url);
  });

  it('handles favicons, businesses and sites with the permission that edits them', async () => {
    const w = await world();
    const favicon = await w.setLogo(w.boss, { purpose: 'company.favicon' }, png(64, 64));
    expect((await w.persistence.companies.get('A'))?.faviconUrl).toBe(favicon.url);
    const shopLogo = await w.setLogo(w.boss, { purpose: 'business.logo', targetId: 'shop' });
    expect((await w.persistence.businesses.get('shop'))?.logoUrl).toBe(shopLogo.url);

    // La sede de un negocio se administra desde ese negocio.
    const keeper = w.user('keeper');
    await w.give('keeper', 'site-admin', { type: 'business', id: 'shop' });
    const siteLogo = await w.setLogo(keeper, { purpose: 'site.logo', targetId: 'north' });
    expect((await w.persistence.sites.get('north'))?.logoUrl).toBe(siteLogo.url);
    // …pero no la sede que cuelga directamente de la compañía.
    await rejectsWith(
      w.upload(keeper, { purpose: 'site.logo', targetId: 'hq' }),
      'AXEDA_SITE_NOT_FOUND',
    );
  });

  it('refuses people without the permission, hiding what they cannot see, and audits it', async () => {
    const w = await world();
    await rejectsWith(w.upload(w.nobody, {}), 'AXEDA_FORBIDDEN');
    await rejectsWith(w.upload(w.boss, { targetId: 'B' }), 'AXEDA_COMPANY_NOT_FOUND');
    await rejectsWith(w.upload(w.boss, { targetId: 'ghost' }), 'AXEDA_COMPANY_NOT_FOUND');
    expect(w.storage.keys()).toEqual([]);
    const denied = await w.axeda.listAudit(w.admin, { action: 'image.set' }, { limit: 10 });
    expect(denied.items.map((event) => event.outcome)).toEqual(['denied', 'denied', 'denied']);
  });

  it('validates what is declared before signing anything', async () => {
    const w = await world();
    const ask = (input: Record<string, unknown>) =>
      w.axeda.images.createUpload(w.boss, {
        purpose: 'company.logo',
        targetId: 'A',
        contentType: 'image/png',
        size: 100,
        ...input,
      } as never);
    for (const contentType of ['image/svg+xml', 'image/gif', 'text/html', 'image/x-icon']) {
      await rejectsWith(ask({ contentType }), 'AXEDA_INVALID_INPUT');
    }
    await rejectsWith(ask({ size: 2 * 1024 * 1024 + 1 }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(ask({ size: 0 }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(ask({ purpose: 'company.banner' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(ask({ extra: true }), 'AXEDA_INVALID_INPUT');
    expect(await w.persistence.images.countPendingBy('boss', w.clock.current)).toBe(0);
  });

  it('refuses a signed upload sent with another content type, like R2 does', async () => {
    const w = await world();
    const ticket = await w.axeda.images.createUpload(w.boss, {
      purpose: 'company.logo',
      targetId: 'A',
      contentType: 'image/png',
      size: 64,
    });
    await expect(
      w.storage.upload({ ...ticket, headers: { 'content-type': 'text/html' } }, svg()),
    ).rejects.toThrow(/SignatureDoesNotMatch/);
  });
});

describe('checking what was uploaded', () => {
  it('decides the type by the bytes: a page renamed as a PNG is deleted and refused', async () => {
    const w = await world();
    const ticket = await w.upload(w.boss, {}, svg());
    const error = await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_IMAGE_INVALID');
    expect(error.details).toEqual({ reason: 'not_an_image' });
    expect(w.storage.keys()).toEqual([]);
    expect(await w.persistence.images.get(ticket.uploadId)).toBeNull();
    expect((await w.persistence.companies.get('A'))?.logoUrl).toBeNull();
  });

  it('refuses a real image of another type than the one declared', async () => {
    const w = await world();
    const ticket = await w.upload(w.boss, { contentType: 'image/png' }, jpeg(100, 100));
    await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_IMAGE_INVALID');
  });

  it('refuses a file larger than the limit even if a small size was declared', async () => {
    const w = await world();
    const ticket = await w.axeda.images.createUpload(w.boss, {
      purpose: 'company.logo',
      targetId: 'A',
      contentType: 'image/png',
      size: 100,
    });
    // R2 no hace cumplir el tamaño firmado: alguien sube más de lo que dijo.
    w.storage.put(
      ticket.url.slice('memory://'.length).split('?')[0] ?? '',
      png(10, 10, 3 * 1024 * 1024),
    );
    const error = await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_IMAGE_INVALID');
    expect(error.details).toEqual({ reason: 'too_large' });
    expect(w.storage.keys()).toEqual([]);
  });

  it('limits the pixels: 4096 per side for a logo and 1024 for a favicon', async () => {
    const w = await world();
    expect((await w.setLogo(w.boss, {}, png(4096, 4096))).url).not.toBeNull();
    const big = await w.upload(w.boss, {}, png(4097, 10));
    const error = await rejectsWith(w.complete(w.boss, big.uploadId), 'AXEDA_IMAGE_INVALID');
    expect(error.details).toEqual({ reason: 'too_many_pixels' });
    const icon = await w.upload(w.boss, { purpose: 'company.favicon' }, webpLossy(2048, 2048));
    await rejectsWith(w.complete(w.boss, icon.uploadId), 'AXEDA_IMAGE_INVALID');
  });

  it('says when nothing was uploaded yet, and lets the person try again', async () => {
    const w = await world();
    const ticket = await w.axeda.images.createUpload(w.boss, {
      purpose: 'company.logo',
      targetId: 'A',
      contentType: 'image/png',
      size: 64,
    });
    const error = await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_UPLOAD_INVALID');
    expect(error.details).toEqual({ reason: 'not_uploaded' });
    await w.storage.upload(ticket, png(10, 10));
    expect((await w.complete(w.boss, ticket.uploadId)).url).not.toBeNull();
  });

  it('only lets the person who asked complete it, once, before it expires', async () => {
    const w = await world();
    const other = w.user('other');
    await w.give('other', 'company-admin', { type: 'company', id: 'A' });
    const ticket = await w.upload(w.boss, {});
    await rejectsWith(w.complete(other, ticket.uploadId), 'AXEDA_UPLOAD_INVALID');
    await rejectsWith(w.complete(w.boss, 'nope'), 'AXEDA_UPLOAD_INVALID');
    await rejectsWith(w.complete(w.boss, undefined as never), 'AXEDA_UPLOAD_INVALID');
    await w.complete(w.boss, ticket.uploadId);
    await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_UPLOAD_INVALID');

    const late = await w.upload(w.boss, {});
    w.clock.current = new Date(w.clock.current.getTime() + 10 * 60_000);
    await rejectsWith(w.complete(w.boss, late.uploadId), 'AXEDA_UPLOAD_INVALID');
  });

  it('does not set the logo if the person lost access in between', async () => {
    const w = await world();
    const ticket = await w.upload(w.boss, {});
    const [assignment] = (await w.persistence.assignments.listForUser('boss')) ?? [];
    await w.axeda.assignments.revoke(w.admin, assignment?.id ?? '');
    // Ya no ve la compañía: la respuesta es la de algo que no existe.
    await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_COMPANY_NOT_FOUND');
    expect((await w.persistence.companies.get('A'))?.logoUrl).toBeNull();
    // La imagen final que llegó a escribirse se borró; queda solo la subida, para la limpieza.
    expect(w.storage.keys().every((key) => key.startsWith('uploads/'))).toBe(true);
  });

  it('lets exactly one of two simultaneous completions win', async () => {
    const w = await world();
    const ticket = await w.upload(w.boss, {});
    const results = await Promise.allSettled([
      w.complete(w.boss, ticket.uploadId),
      w.complete(w.boss, ticket.uploadId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(w.storage.keys()).toHaveLength(1);
  });

  it('keeps exactly one logo when two different uploads finish at the same time', async () => {
    const w = await world();
    const [a, b] = [
      await w.upload(w.boss, {}),
      await w.upload(w.boss, { contentType: 'image/jpeg' }, jpeg(10, 10)),
    ];
    await Promise.allSettled([w.complete(w.boss, a.uploadId), w.complete(w.boss, b.uploadId)]);
    const images = w.storage.keys().filter((key) => key.startsWith('images/'));
    expect(images).toHaveLength(1);
    expect((await w.persistence.companies.get('A'))?.logoUrl).toBe(
      `https://images.test/${images[0]}`,
    );
  });

  it('caps the uploads one person can leave open', async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) await w.upload(w.boss, {});
    await rejectsWith(w.upload(w.boss, {}), 'AXEDA_LIMIT_EXCEEDED');
    // Las caducadas ya no cuentan.
    w.clock.current = new Date(w.clock.current.getTime() + 11 * 60_000);
    await w.upload(w.boss, {});
  });

  it('re-encodes with the processor when there is one, and checks its output too', async () => {
    const calls: number[] = [];
    const shrink: ImageProcessor = {
      async process(_bytes, options) {
        calls.push(options.maxDimension);
        return { bytes: webpLossy(512, 256), format: 'webp' };
      },
    };
    const w = await world({ imageProcessor: shrink });
    // Con procesador se acepta una imagen más grande: se reduce.
    const result = await w.setLogo(w.boss, {}, png(8000, 4000));
    expect(result.url).toMatch(/\.webp$/);
    expect(calls).toEqual([4096]);
    const [key] = w.storage.keys();
    expect(w.storage.get(key ?? '')?.contentType).toBe('image/webp');
  });

  it('refuses what a broken processor returns', async () => {
    const broken: ImageProcessor = { process: async () => ({ bytes: svg(), format: 'png' }) };
    const w = await world({ imageProcessor: broken });
    const ticket = await w.upload(w.boss, {});
    const error = await rejectsWith(w.complete(w.boss, ticket.uploadId), 'AXEDA_IMAGE_INVALID');
    expect(error.details).toEqual({ reason: 'processing_failed' });
  });
});

describe('removing images and cleaning up', () => {
  it('removes a logo: the company field goes back to null and the object is deleted', async () => {
    const w = await world();
    await w.setLogo(w.boss);
    expect(await w.axeda.images.remove(w.boss, { purpose: 'company.logo', targetId: 'A' })).toEqual(
      {
        purpose: 'company.logo',
        targetId: 'A',
        url: null,
      },
    );
    expect((await w.persistence.companies.get('A'))?.logoUrl).toBeNull();
    expect(w.storage.keys()).toEqual([]);
    await rejectsWith(
      w.axeda.images.remove(w.nobody, { purpose: 'company.logo', targetId: 'A' }),
      'AXEDA_FORBIDDEN',
    );
  });

  it('purges the images of a company, its businesses and its sites with it', async () => {
    const w = await world();
    await w.setLogo(w.boss);
    await w.setLogo(w.boss, { purpose: 'business.logo', targetId: 'shop' });
    await w.setLogo(w.admin, { purpose: 'site.logo', targetId: 'north' });
    await w.setLogo(w.admin, { purpose: 'company.logo', targetId: 'B' });
    const acme = await w.persistence.companies.get('A');
    await w.axeda.companies.delete(w.admin, 'A', acme?.version ?? 0);
    w.clock.current = new Date(w.clock.current.getTime() + 31 * DAY);
    const result = await w.axeda.purgeDeleted();
    expect(result).toMatchObject({ companies: 1, images: 3 });
    // Solo queda el logo de la otra compañía.
    expect(w.storage.keys()).toHaveLength(1);
    expect((await w.persistence.companies.get('B'))?.logoUrl).toContain(w.storage.keys()[0]);
  });

  it('deletes the images right away when a site is deleted for good', async () => {
    const w = await world();
    await w.setLogo(w.admin, { purpose: 'site.logo', targetId: 'hq' });
    await w.setLogo(w.admin, { purpose: 'site.favicon', targetId: 'hq' }, png(32, 32));
    const hq = await w.persistence.sites.get('hq');
    await w.axeda.sites.delete(w.admin, 'hq', hq?.version ?? 0, { immediate: true });
    expect(w.storage.keys()).toEqual([]);
  });

  it('sweeps uploads nobody completed in time', async () => {
    const w = await world();
    await w.upload(w.boss, {});
    await w.upload(w.boss, {});
    expect(w.storage.keys()).toHaveLength(2);
    expect((await w.axeda.purgeDeleted()).images).toBe(0);
    w.clock.current = new Date(w.clock.current.getTime() + 11 * 60_000);
    expect((await w.axeda.purgeDeleted()).images).toBe(2);
    expect(w.storage.keys()).toEqual([]);
  });

  it('is off without an object storage', async () => {
    const w = await world({ images: false });
    await rejectsWith(w.upload(w.boss, {}), 'AXEDA_FEATURE_DISABLED');
  });
});

describe('profile pictures', () => {
  it('lets a person set and remove their own picture', async () => {
    const w = await world();
    const result = await w.setLogo(w.nobody, { purpose: 'user.avatar', targetId: 'nobody' });
    expect((await w.users.get('nobody'))?.image).toBe(result.url);
    await w.axeda.images.remove(w.nobody, { purpose: 'user.avatar', targetId: 'nobody' });
    expect((await w.users.get('nobody'))?.image).toBeNull();
    expect(w.storage.keys()).toEqual([]);
  });

  it('only lets user administrators change somebody else’s picture', async () => {
    const w = await world();
    await rejectsWith(
      w.upload(w.boss, { purpose: 'user.avatar', targetId: 'nobody' }),
      'AXEDA_FORBIDDEN',
    );
    const changed = await w.setLogo(w.admin, { purpose: 'user.avatar', targetId: 'nobody' });
    expect((await w.users.get('nobody'))?.image).toBe(changed.url);
    await rejectsWith(
      w.upload(w.admin, { purpose: 'user.avatar', targetId: 'ghost' }),
      'AXEDA_USER_NOT_FOUND',
    );
  });

  it('forgets the picture of a deleted user', async () => {
    const w = await world();
    await w.setLogo(w.nobody, { purpose: 'user.avatar', targetId: 'nobody' });
    expect(await w.axeda.images.forgetUser('nobody')).toBe(1);
    expect(w.storage.keys()).toEqual([]);
  });
});
