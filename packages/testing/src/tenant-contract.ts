import { GLOBAL_SCOPE, isAxedaError, type AxedaPersistence } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code as never), `expected ${code}, got ${String(error)}`).toBe(true);
};

const FUTURE = new Date('2031-01-01T00:00:00.000Z');
const PAST = new Date('2020-01-01T00:00:00.000Z');

/** Pruebas de contrato de compañías, negocios e invitaciones (parte de `runPersistenceContract`). */
export function defineTenantContract(database: () => AxedaPersistence): void {
  const company = (slug = 'acme') =>
    database().companies.create({ slug, name: slug.toUpperCase() });

  describe('companies', () => {
    it('creates a company with defaults and reads it by id and slug', async () => {
      const created = await database().companies.create({
        slug: 'acme',
        name: 'ACME',
        legalName: 'ACME S.A. de C.V.',
        logoUrl: 'https://cdn.example/acme.png',
        metadata: { tier: 'gold', nested: { ok: true } },
      });
      expect(created).toMatchObject({
        slug: 'acme',
        name: 'ACME',
        legalName: 'ACME S.A. de C.V.',
        logoUrl: 'https://cdn.example/acme.png',
        faviconUrl: null,
        status: 'active',
        version: 1,
        deletedAt: null,
        metadata: { tier: 'gold', nested: { ok: true } },
      });
      expect(await database().companies.get(created.id)).toEqual(created);
      expect(await database().companies.getBySlug('acme')).toEqual(created);
      expect(await database().companies.get('nope')).toBeNull();
      expect(await database().companies.getBySlug('nope')).toBeNull();
    });

    it('rejects a duplicate slug, even while the first company is deleted', async () => {
      const first = await company();
      await expectCode(company(), 'AXEDA_SLUG_TAKEN');
      await database().companies.setDeleted(first.id, 1, new Date());
      await expectCode(company(), 'AXEDA_SLUG_TAKEN');
    });

    it('lets exactly one of two concurrent creations of the same slug win', async () => {
      const results = await Promise.allSettled([company('race'), company('race')]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(
        isAxedaError(rejected?.status === 'rejected' ? rejected.reason : null, 'AXEDA_SLUG_TAKEN'),
      ).toBe(true);
    });

    it('updates with the expected version and bumps it, keeping the rest', async () => {
      const created = await company();
      const updated = await database().companies.update(created.id, 1, {
        name: 'ACME 2',
        legalName: 'Legal',
        metadata: { a: 1 },
      });
      expect(updated).toMatchObject({
        name: 'ACME 2',
        legalName: 'Legal',
        version: 2,
        slug: 'acme',
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
      const cleared = await database().companies.update(created.id, 2, { legalName: null });
      expect(cleared.legalName).toBeNull();
      expect(cleared.name).toBe('ACME 2');
      expect(cleared.metadata).toEqual({ a: 1 });
    });

    it('rejects a stale version and an unknown company', async () => {
      const created = await company();
      await database().companies.update(created.id, 1, { name: 'first' });
      await expectCode(
        database().companies.update(created.id, 1, { name: 'second' }),
        'AXEDA_VERSION_CONFLICT',
      );
      await expectCode(
        database().companies.update('nope', 1, { name: 'x' }),
        'AXEDA_COMPANY_NOT_FOUND',
      );
      await expectCode(
        database().companies.setStatus('nope', 1, 'inactive'),
        'AXEDA_COMPANY_NOT_FOUND',
      );
      expect((await database().companies.get(created.id))?.name).toBe('first');
    });

    it('changes the status and soft-deletes and restores, bumping the version each time', async () => {
      const created = await company();
      const off = await database().companies.setStatus(created.id, 1, 'inactive');
      expect(off).toMatchObject({ status: 'inactive', version: 2 });
      const at = new Date('2030-03-03T03:03:03.000Z');
      const deleted = await database().companies.setDeleted(created.id, 2, at);
      expect(deleted.deletedAt?.getTime()).toBe(at.getTime());
      expect(deleted.version).toBe(3);
      const restored = await database().companies.setDeleted(created.id, 3, null);
      expect(restored).toMatchObject({ deletedAt: null, version: 4, status: 'inactive' });
    });

    it('lists by slug with cursor pagination and the deleted filter', async () => {
      for (const slug of ['d', 'a', 'c', 'b']) await company(slug);
      const b = await database().companies.getBySlug('b');
      await database().companies.setDeleted(b?.id ?? '', 1, new Date());

      const first = await database().companies.list({}, { limit: 2 });
      expect(first.items.map((item) => item.slug)).toEqual(['a', 'c']);
      const second = await database().companies.list(
        {},
        { limit: 2, cursor: first.nextCursor ?? '' },
      );
      expect(second.items.map((item) => item.slug)).toEqual(['d']);
      expect(second.nextCursor).toBeNull();

      const slugs = async (deleted: 'exclude' | 'include' | 'only') =>
        (await database().companies.list({ deleted }, { limit: 10 })).items.map(
          (item) => item.slug,
        );
      expect(await slugs('include')).toEqual(['a', 'b', 'c', 'd']);
      expect(await slugs('only')).toEqual(['b']);
    });

    it('lists only the requested ids, and nothing for an empty list', async () => {
      const a = await company('a');
      await company('b');
      const ids = async (list: string[]) =>
        (await database().companies.list({ ids: list }, { limit: 10 })).items.map(
          (item) => item.id,
        );
      expect(await ids([a.id, 'missing'])).toEqual([a.id]);
      expect(await ids([])).toEqual([]);
      expect(
        (await database().companies.getMany([a.id, 'missing'])).map((item) => item.id),
      ).toEqual([a.id]);
      expect(await database().companies.getMany([])).toEqual([]);
    });

    it('finds the companies deleted before a date', async () => {
      const old = await company('old');
      const recent = await company('recent');
      await company('alive');
      await database().companies.setDeleted(old.id, 1, new Date('2025-01-01T00:00:00.000Z'));
      await database().companies.setDeleted(recent.id, 1, new Date('2029-01-01T00:00:00.000Z'));
      const found = await database().companies.listDeletedBefore(
        new Date('2027-01-01T00:00:00.000Z'),
        10,
      );
      expect(found.map((item) => item.slug)).toEqual(['old']);
    });

    it('purges a company with everything that belongs to it, and only that', async () => {
      const db = database();
      const doomed = await db.companies.create({ slug: 'doomed', name: 'D' });
      const kept = await db.companies.create({ slug: 'kept', name: 'K' });
      const shop = await db.businesses.create({ companyId: doomed.id, slug: 'shop', name: 'Shop' });
      const other = await db.businesses.create({ companyId: kept.id, slug: 'shop', name: 'Shop' });
      const role = await db.roles.create({ key: 'r', name: 'R', permissions: [] });
      const grant = (scope: Parameters<typeof db.assignments.create>[0]['scope']) =>
        db.assignments.create({ userId: 'u1', roleId: role.id, scope });
      await grant({ type: 'company', id: doomed.id });
      await grant({ type: 'business', id: shop.id });
      await grant({ type: 'company', id: kept.id });
      await grant({ type: 'business', id: other.id });
      await grant(GLOBAL_SCOPE);
      for (const scope of [
        { type: 'company', id: doomed.id },
        { type: 'company', id: kept.id },
      ] as const) {
        await db.invitations.create({
          email: 'x@test.dev',
          scope,
          roleIds: [role.id],
          invitedBy: 'u1',
          expiresAt: FUTURE,
          secretHash: 'h',
        });
      }

      expect(await db.companies.purge([doomed.id, 'missing'])).toBe(1);

      expect(await db.companies.get(doomed.id)).toBeNull();
      expect(await db.businesses.get(shop.id)).toBeNull();
      expect(await db.companies.get(kept.id)).not.toBeNull();
      expect(await db.businesses.get(other.id)).not.toBeNull();
      const left = await db.assignments.listForUser('u1');
      expect(
        left
          .map((item) => item.scope)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ).toEqual(
        [{ type: 'business', id: other.id }, { type: 'company', id: kept.id }, GLOBAL_SCOPE].sort(
          (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      );
      expect(
        await db.invitations.findPending('x@test.dev', { type: 'company', id: doomed.id }),
      ).toBeNull();
      expect(
        await db.invitations.findPending('x@test.dev', { type: 'company', id: kept.id }),
      ).not.toBeNull();
      expect(await db.companies.purge([])).toBe(0);
    });

    it('is rolled back with its transaction', async () => {
      await expect(
        database().transaction(async (tx) => {
          await tx.companies.create({ slug: 'ghost', name: 'G' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await database().companies.getBySlug('ghost')).toBeNull();
    });
  });

  describe('businesses', () => {
    it('creates a business inside a company and reads it back', async () => {
      const parent = await company();
      const created = await database().businesses.create({
        companyId: parent.id,
        slug: 'main',
        name: 'Main',
        faviconUrl: 'https://cdn.example/f.ico',
        metadata: { city: 'CDMX' },
      });
      expect(created).toMatchObject({
        companyId: parent.id,
        slug: 'main',
        status: 'active',
        version: 1,
        deletedAt: null,
        faviconUrl: 'https://cdn.example/f.ico',
        metadata: { city: 'CDMX' },
      });
      expect(await database().businesses.get(created.id)).toEqual(created);
      expect(await database().businesses.getBySlug(parent.id, 'main')).toEqual(created);
      expect(await database().businesses.getBySlug(parent.id, 'nope')).toBeNull();
    });

    it('requires an existing company', async () => {
      await expectCode(
        database().businesses.create({ companyId: 'missing', slug: 's', name: 'S' }),
        'AXEDA_COMPANY_NOT_FOUND',
      );
    });

    it('keeps slugs unique per company, not globally', async () => {
      const a = await company('a');
      const b = await company('b');
      await database().businesses.create({ companyId: a.id, slug: 'main', name: 'A main' });
      await expectCode(
        database().businesses.create({ companyId: a.id, slug: 'main', name: 'again' }),
        'AXEDA_SLUG_TAKEN',
      );
      await database().businesses.create({ companyId: b.id, slug: 'main', name: 'B main' });
    });

    it('lets exactly one of two concurrent creations of the same slug win', async () => {
      const parent = await company();
      const make = () =>
        database().businesses.create({ companyId: parent.id, slug: 'race', name: 'R' });
      const results = await Promise.allSettled([make(), make()]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('updates, changes status, soft-deletes and restores with versions; the company never changes', async () => {
      const parent = await company();
      const created = await database().businesses.create({
        companyId: parent.id,
        slug: 'main',
        name: 'Main',
      });
      const renamed = await database().businesses.update(created.id, 1, {
        name: 'Renamed',
        logoUrl: 'https://x/y.png',
      });
      expect(renamed).toMatchObject({
        name: 'Renamed',
        logoUrl: 'https://x/y.png',
        version: 2,
        companyId: parent.id,
      });
      const off = await database().businesses.setStatus(created.id, 2, 'inactive');
      expect(off.status).toBe('inactive');
      const deleted = await database().businesses.setDeleted(created.id, 3, new Date());
      expect(deleted.deletedAt).not.toBeNull();
      const back = await database().businesses.setDeleted(created.id, 4, null);
      expect(back).toMatchObject({ deletedAt: null, version: 5, companyId: parent.id });
      await expectCode(
        database().businesses.update(created.id, 1, { name: 'old' }),
        'AXEDA_VERSION_CONFLICT',
      );
      await expectCode(
        database().businesses.update('nope', 1, { name: 'x' }),
        'AXEDA_BUSINESS_NOT_FOUND',
      );
    });

    it('lists the businesses of one company with filters and pagination', async () => {
      const a = await company('a');
      const b = await company('b');
      for (const slug of ['z', 'x', 'y'])
        await database().businesses.create({ companyId: a.id, slug, name: slug });
      await database().businesses.create({ companyId: b.id, slug: 'other', name: 'o' });
      const y = await database().businesses.getBySlug(a.id, 'y');
      await database().businesses.setDeleted(y?.id ?? '', 1, new Date());

      const first = await database().businesses.listForCompany(a.id, {}, { limit: 1 });
      expect(first.items.map((item) => item.slug)).toEqual(['x']);
      const rest = await database().businesses.listForCompany(
        a.id,
        {},
        { limit: 5, cursor: first.nextCursor ?? '' },
      );
      expect(rest.items.map((item) => item.slug)).toEqual(['z']);
      const only = await database().businesses.listForCompany(
        a.id,
        { deleted: 'only' },
        { limit: 5 },
      );
      expect(only.items.map((item) => item.slug)).toEqual(['y']);
      const ids = await database().businesses.listForCompany(
        a.id,
        { ids: [y?.id ?? ''], deleted: 'include' },
        { limit: 5 },
      );
      expect(ids.items).toHaveLength(1);
      expect(
        (await database().businesses.getMany([y?.id ?? '', 'missing'])).map((item) => item.slug),
      ).toEqual(['y']);
    });

    it('finds the businesses deleted before a date', async () => {
      const parent = await company();
      const old = await database().businesses.create({
        companyId: parent.id,
        slug: 'old',
        name: 'o',
      });
      await database().businesses.setDeleted(old.id, 1, PAST);
      const found = await database().businesses.listDeletedBefore(
        new Date('2027-01-01T00:00:00.000Z'),
        10,
      );
      expect(found.map((item) => item.id)).toEqual([old.id]);
    });

    it('purges a business with its assignments and invitations only', async () => {
      const db = database();
      const parent = await db.companies.create({ slug: 'p', name: 'P' });
      const gone = await db.businesses.create({ companyId: parent.id, slug: 'gone', name: 'G' });
      const stays = await db.businesses.create({ companyId: parent.id, slug: 'stays', name: 'S' });
      const role = await db.roles.create({ key: 'r', name: 'R', permissions: [] });
      await db.assignments.create({
        userId: 'u1',
        roleId: role.id,
        scope: { type: 'business', id: gone.id },
      });
      await db.assignments.create({
        userId: 'u1',
        roleId: role.id,
        scope: { type: 'business', id: stays.id },
      });
      await db.invitations.create({
        email: 'a@test.dev',
        scope: { type: 'business', id: gone.id },
        roleIds: [role.id],
        invitedBy: 'u1',
        expiresAt: FUTURE,
        secretHash: 'h',
      });

      expect(await db.businesses.purge([gone.id, 'missing'])).toBe(1);
      expect(await db.businesses.get(gone.id)).toBeNull();
      expect(await db.businesses.get(stays.id)).not.toBeNull();
      expect(await db.companies.get(parent.id)).not.toBeNull();
      expect((await db.assignments.listForUser('u1')).map((item) => item.scope)).toEqual([
        { type: 'business', id: stays.id },
      ]);
      expect(
        await db.invitations.findPending('a@test.dev', { type: 'business', id: gone.id }),
      ).toBeNull();
    });
  });

  describe('sites', () => {
    /** Una compañía con un negocio, y otra compañía con su propio negocio. */
    async function parents() {
      const db = database();
      const acme = await company('acme');
      const shop = await db.businesses.create({ companyId: acme.id, slug: 'shop', name: 'Shop' });
      const other = await company('other');
      const elsewhere = await db.businesses.create({
        companyId: other.id,
        slug: 'shop',
        name: 'Shop',
      });
      return { db, acme, shop, other, elsewhere };
    }

    it('creates a site under a company or under one of its businesses, and reads it back', async () => {
      const { db, acme, shop } = await parents();
      const direct = await db.sites.create({ companyId: acme.id, slug: 'north', name: 'North' });
      expect(direct).toMatchObject({
        companyId: acme.id,
        businessId: null,
        slug: 'north',
        name: 'North',
        logoUrl: null,
        faviconUrl: null,
        status: 'active',
        metadata: {},
        version: 1,
        deletedAt: null,
      });
      const inShop = await db.sites.create({
        companyId: acme.id,
        businessId: shop.id,
        slug: 'south',
        name: 'South',
        metadata: { city: 'Monterrey' },
      });
      expect(inShop).toMatchObject({ businessId: shop.id, metadata: { city: 'Monterrey' } });
      expect(await db.sites.get(inShop.id)).toEqual(inShop);
      expect(await db.sites.getBySlug(acme.id, 'south')).toEqual(inShop);
      expect(await db.sites.get('nope')).toBeNull();
      expect((await db.sites.getMany([direct.id, inShop.id, 'nope'])).length).toBe(2);
    });

    it('requires an existing company, and a business of that same company', async () => {
      const { db, acme, elsewhere } = await parents();
      await expectCode(
        db.sites.create({ companyId: 'missing', slug: 'x', name: 'X' }),
        'AXEDA_COMPANY_NOT_FOUND',
      );
      await expectCode(
        db.sites.create({ companyId: acme.id, businessId: 'missing', slug: 'x', name: 'X' }),
        'AXEDA_BUSINESS_NOT_FOUND',
      );
      await expectCode(
        db.sites.create({ companyId: acme.id, businessId: elsewhere.id, slug: 'x', name: 'X' }),
        'AXEDA_BUSINESS_NOT_FOUND',
      );
    });

    it('keeps slugs unique per company, whether the site hangs from a business or not', async () => {
      const { db, acme, shop, other } = await parents();
      await db.sites.create({ companyId: acme.id, slug: 'one', name: 'One' });
      await expectCode(
        db.sites.create({ companyId: acme.id, businessId: shop.id, slug: 'one', name: 'Again' }),
        'AXEDA_SLUG_TAKEN',
      );
      await expect(
        db.sites.create({ companyId: other.id, slug: 'one', name: 'Elsewhere' }),
      ).resolves.toMatchObject({ companyId: other.id });
    });

    it('lets exactly one of two concurrent creations of the same slug win', async () => {
      const { db, acme } = await parents();
      const results = await Promise.allSettled([
        db.sites.create({ companyId: acme.id, slug: 'race', name: 'A' }),
        db.sites.create({ companyId: acme.id, slug: 'race', name: 'B' }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('updates, changes status, soft-deletes and restores with versions; the parents never change', async () => {
      const { db, acme, shop } = await parents();
      const created = await db.sites.create({
        companyId: acme.id,
        businessId: shop.id,
        slug: 's',
        name: 'S',
      });
      const renamed = await db.sites.update(created.id, 1, { name: 'Renamed', logoUrl: null });
      expect(renamed).toMatchObject({ name: 'Renamed', version: 2, businessId: shop.id });
      await expectCode(db.sites.update(created.id, 1, { name: 'Stale' }), 'AXEDA_VERSION_CONFLICT');
      await expectCode(db.sites.update('missing', 1, { name: 'X' }), 'AXEDA_SITE_NOT_FOUND');
      const off = await db.sites.setStatus(created.id, 2, 'inactive');
      expect(off).toMatchObject({ status: 'inactive', version: 3 });
      const deleted = await db.sites.setDeleted(created.id, 3, PAST);
      expect(deleted.deletedAt).toEqual(PAST);
      const restored = await db.sites.setDeleted(created.id, 4, null);
      expect(restored).toMatchObject({ deletedAt: null, version: 5, companyId: acme.id });
    });

    it('lists by slug with cursor pagination, by business, and only what someone may see', async () => {
      const { db, acme, shop } = await parents();
      const make = (slug: string, businessId?: string) =>
        db.sites.create({
          companyId: acme.id,
          slug,
          name: slug,
          ...(businessId === undefined ? {} : { businessId }),
        });
      const a = await make('a');
      const b = await make('b', shop.id);
      await make('c', shop.id);
      const d = await make('d');
      const slugs = (page: { items: readonly { slug: string }[] }) => page.items.map((s) => s.slug);

      const first = await db.sites.listForCompany(acme.id, {}, { limit: 2 });
      expect(slugs(first)).toEqual(['a', 'b']);
      const rest = await db.sites.listForCompany(
        acme.id,
        {},
        { limit: 2, ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) },
      );
      expect(slugs(rest)).toEqual(['c', 'd']);
      expect(
        slugs(await db.sites.listForCompany(acme.id, { businessId: shop.id }, { limit: 9 })),
      ).toEqual(['b', 'c']);
      expect(
        slugs(await db.sites.listForCompany(acme.id, { businessId: null }, { limit: 9 })),
      ).toEqual(['a', 'd']);

      // (sus sedes) OR (las de sus negocios), siempre dentro de la compañía.
      const visible = (siteIds: string[], businessIds: string[]) =>
        db.sites
          .listForCompany(acme.id, { visible: { siteIds, businessIds } }, { limit: 9 })
          .then(slugs);
      expect(await visible([a.id], [])).toEqual(['a']);
      expect(await visible([d.id], [shop.id])).toEqual(['b', 'c', 'd']);
      expect(await visible([], [])).toEqual([]);
      await db.sites.setDeleted(b.id, 1, new Date());
      expect(await visible([], [shop.id])).toEqual(['c']);
    });

    it('finds the sites deleted before a date', async () => {
      const { db, acme } = await parents();
      const old = await db.sites.create({ companyId: acme.id, slug: 'old', name: 'O' });
      const recent = await db.sites.create({ companyId: acme.id, slug: 'new', name: 'N' });
      await db.sites.setDeleted(old.id, 1, PAST);
      await db.sites.setDeleted(recent.id, 1, new Date());
      const found = await db.sites.listDeletedBefore(new Date('2025-01-01T00:00:00.000Z'), 10);
      expect(found.map((site) => site.id)).toEqual([old.id]);
    });

    it('purges a site, and a business or a company purges its sites, with their assignments and invitations', async () => {
      const { db, acme, shop } = await parents();
      const role = await db.roles.create({ key: 'r', name: 'R', permissions: [] });
      const direct = await db.sites.create({ companyId: acme.id, slug: 'direct', name: 'D' });
      const inShop = await db.sites.create({
        companyId: acme.id,
        businessId: shop.id,
        slug: 'inshop',
        name: 'I',
      });
      const lonely = await db.sites.create({ companyId: acme.id, slug: 'lonely', name: 'L' });
      for (const site of [direct, inShop, lonely]) {
        await db.assignments.create({
          userId: 'u1',
          roleId: role.id,
          scope: { type: 'site', id: site.id },
        });
      }
      await db.invitations.create({
        email: 'a@test.dev',
        scope: { type: 'site', id: inShop.id },
        roleIds: [role.id],
        invitedBy: 'u1',
        expiresAt: FUTURE,
        secretHash: 'h',
      });
      const scopes = async () =>
        (await db.assignments.listForUser('u1'))
          .map((item) => item.scope.type === 'site' && item.scope.id)
          .sort();

      expect(await db.sites.purge([lonely.id, 'missing'])).toBe(1);
      expect(await db.sites.get(lonely.id)).toBeNull();
      expect(await scopes()).toEqual([direct.id, inShop.id].sort());

      expect(await db.businesses.purge([shop.id])).toBe(1);
      expect(await db.sites.get(inShop.id)).toBeNull();
      expect(await db.sites.get(direct.id)).not.toBeNull();
      expect(await scopes()).toEqual([direct.id]);
      expect(
        await db.invitations.findPending('a@test.dev', { type: 'site', id: inShop.id }),
      ).toBeNull();

      expect(await db.companies.purge([acme.id])).toBe(1);
      expect(await db.sites.get(direct.id)).toBeNull();
      expect(await scopes()).toEqual([]);
    });
  });

  describe('invitations', () => {
    const scope = { type: 'company', id: 'c1' } as const;
    const input = (
      overrides: Partial<Parameters<AxedaPersistence['invitations']['create']>[0]> = {},
    ) => ({
      email: 'new@test.dev',
      scope,
      roleIds: ['r1', 'r2'],
      invitedBy: 'u1',
      expiresAt: FUTURE,
      secretHash: 'hash-1',
      ...overrides,
    });

    it('creates an invitation and reads it back, with its secret hash', async () => {
      const created = await database().invitations.create(input());
      expect(created).toMatchObject({
        email: 'new@test.dev',
        scope,
        roleIds: ['r1', 'r2'],
        invitedBy: 'u1',
        secretHash: 'hash-1',
        acceptedAt: null,
        revokedAt: null,
      });
      expect(created.expiresAt.getTime()).toBe(FUTURE.getTime());
      expect(await database().invitations.get(created.id)).toEqual(created);
      expect(await database().invitations.get('nope')).toBeNull();
      expect(await database().invitations.findPending('new@test.dev', scope)).toEqual(created);
    });

    it('allows one pending invitation per email and scope, but not per email alone', async () => {
      await database().invitations.create(input());
      await expectCode(
        database().invitations.create(input({ secretHash: 'other' })),
        'AXEDA_INVITATION_EXISTS',
      );
      await database().invitations.create(input({ scope: { type: 'company', id: 'c2' } }));
      await database().invitations.create(input({ scope: GLOBAL_SCOPE }));
      await database().invitations.create(input({ email: 'someone@test.dev' }));
    });

    it('stores a phone invitation by its number, apart from email invitations', async () => {
      const phone = '+5215512345678';
      const byPhone = await database().invitations.create(
        input({ channel: 'phone', email: '', phoneNumber: phone }),
      );
      expect(byPhone).toMatchObject({ channel: 'phone', email: '', phoneNumber: phone });
      expect(await database().invitations.get(byPhone.id)).toEqual(byPhone);
      expect(await database().invitations.findPending(phone, scope)).toEqual(byPhone);
      await expectCode(
        database().invitations.create(
          input({ channel: 'phone', email: '', phoneNumber: phone, secretHash: 'other' }),
        ),
        'AXEDA_INVITATION_EXISTS',
      );
      // Una por correo al mismo alcance no choca, y por omisión el canal es el correo.
      const byMail = await database().invitations.create(input());
      expect(byMail).toMatchObject({ channel: 'email', email: 'new@test.dev', phoneNumber: null });
      const listed = await database().invitations.list(
        scope,
        { pendingOnly: true, now: new Date('2026-06-01T00:00:00.000Z') },
        { limit: 10 },
      );
      expect(listed.items.map((item) => [item.channel, item.phoneNumber]).sort()).toEqual([
        ['email', null],
        ['phone', phone],
      ]);
    });

    it('lets exactly one of two concurrent identical invitations win', async () => {
      const results = await Promise.allSettled([
        database().invitations.create(input()),
        database().invitations.create(input({ secretHash: 'h2' })),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('closes an invitation once: accepted or revoked, never both', async () => {
      const created = await database().invitations.create(input());
      const at = new Date('2030-01-01T00:00:00.000Z');
      expect(await database().invitations.close(created.id, 'accepted', at)).toBe(true);
      expect(await database().invitations.close(created.id, 'accepted', at)).toBe(false);
      expect(await database().invitations.close(created.id, 'revoked', at)).toBe(false);
      const read = await database().invitations.get(created.id);
      expect(read?.acceptedAt?.getTime()).toBe(at.getTime());
      expect(read?.revokedAt).toBeNull();
      expect(await database().invitations.findPending('new@test.dev', scope)).toBeNull();
      expect(await database().invitations.close('missing', 'revoked', at)).toBe(false);
    });

    it('lets exactly one of several concurrent closes win', async () => {
      const created = await database().invitations.create(input());
      const at = new Date();
      const results = await Promise.all([
        database().invitations.close(created.id, 'accepted', at),
        database().invitations.close(created.id, 'accepted', at),
        database().invitations.close(created.id, 'revoked', at),
        database().invitations.close(created.id, 'accepted', at),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('frees the slot for a new pending invitation once the old one is closed', async () => {
      const first = await database().invitations.create(input());
      await database().invitations.close(first.id, 'revoked', new Date());
      const second = await database().invitations.create(input({ secretHash: 'hash-2' }));
      expect(second.id).not.toBe(first.id);
      expect((await database().invitations.findPending('new@test.dev', scope))?.id).toBe(second.id);
    });

    it('lists the invitations of a scope without ever returning the secret hash', async () => {
      await database().invitations.create(input());
      const closed = await database().invitations.create(input({ email: 'closed@test.dev' }));
      await database().invitations.close(closed.id, 'accepted', new Date());
      await database().invitations.create(input({ email: 'expired@test.dev', expiresAt: PAST }));
      await database().invitations.create(input({ scope: { type: 'company', id: 'other' } }));
      const now = new Date('2026-06-01T00:00:00.000Z');

      const all = await database().invitations.list(
        scope,
        { pendingOnly: false, now },
        { limit: 10 },
      );
      expect(all.items.map((item) => item.email).sort()).toEqual([
        'closed@test.dev',
        'expired@test.dev',
        'new@test.dev',
      ]);
      for (const item of all.items) expect(item).not.toHaveProperty('secretHash');

      const pending = await database().invitations.list(
        scope,
        { pendingOnly: true, now },
        { limit: 10 },
      );
      expect(pending.items.map((item) => item.email)).toEqual(['new@test.dev']);

      const first = await database().invitations.list(
        scope,
        { pendingOnly: false, now },
        { limit: 2 },
      );
      const second = await database().invitations.list(
        scope,
        { pendingOnly: false, now },
        { limit: 2, cursor: first.nextCursor ?? '' },
      );
      expect([...first.items, ...second.items]).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
    });
  });
}
