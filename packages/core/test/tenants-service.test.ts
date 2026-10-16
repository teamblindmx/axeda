import { describe, expect, it } from 'vitest';
import { isAxedaError, type AxedaErrorCode } from '../src/index.js';
import { createFixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error & { details: Record<string, unknown> };
};

const DAY = 86_400_000;

/** Dos compañías, un administrador de plataforma, uno de cada compañía y un cajero. */
async function world() {
  const f = await createFixture();
  const acme = await f.company('A');
  const globex = await f.company('B');
  await f.business('a1', 'A');
  await f.business('b1', 'B');
  await f.role('company-admin', [
    'axeda:company:manage',
    'axeda:business:manage',
    'axeda:assignment:manage',
    'invoice:*',
  ]);
  await f.role('cashier', ['invoice:read']);
  const adminA = f.user('adminA');
  const adminB = f.user('adminB');
  const cashier = f.user('cashier');
  await f.give('adminA', 'company-admin', { type: 'company', id: 'A' });
  await f.give('adminB', 'company-admin', { type: 'company', id: 'B' });
  await f.give('cashier', 'cashier', { type: 'business', id: 'a1' });
  return { ...f, acme, globex, adminA, adminB, cashier };
}

describe('companies: creating and reading', () => {
  it('lets a platform administrator create a company, and audits it', async () => {
    const f = await createFixture();
    const company = await f.axeda.companies.create(f.admin, {
      slug: 'acme',
      name: 'ACME',
      legalName: 'ACME S.A.',
      logoUrl: 'https://cdn.example/logo.png',
      metadata: { tier: 'gold' },
    });
    expect(company).toMatchObject({ slug: 'acme', status: 'active', version: 1, deletedAt: null });
    const [event] = (await f.axeda.listAudit(f.admin, { action: 'company.create' }, { limit: 1 }))
      .items;
    expect(event).toMatchObject({
      targetId: company.id,
      outcome: 'success',
      metadata: { slug: 'acme' },
    });
  });

  it('authorizes before validating, so a stranger learns nothing about slugs', async () => {
    const f = await createFixture();
    await f.axeda.companies.create(f.admin, { slug: 'taken', name: 'T' });
    const stranger = f.user('stranger');
    for (const input of [
      { slug: 'taken', name: 'x' },
      { slug: 'Bad Slug', name: 'x' },
      { slug: 'ok', name: 'x', surprise: 1 },
    ]) {
      await rejectsWith(f.axeda.companies.create(stranger, input as never), 'AXEDA_FORBIDDEN');
    }
  });

  it('rejects invalid input: slugs, unsafe logo URLs, oversized or deep metadata, unknown fields', async () => {
    const f = await createFixture();
    const bad = (input: unknown) => f.axeda.companies.create(f.admin, input as never);
    await rejectsWith(bad({ slug: 'Upper', name: 'x' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad({ slug: '-lead', name: 'x' }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad({ slug: 'ok', name: '' }), 'AXEDA_INVALID_INPUT');
    for (const logoUrl of [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/relative.png',
      'http://evil.example/x.png',
      'ftp://x/y',
    ]) {
      await rejectsWith(bad({ slug: 'ok', name: 'x', logoUrl }), 'AXEDA_INVALID_INPUT');
    }
    await rejectsWith(
      bad({ slug: 'ok', name: 'x', metadata: { big: 'x'.repeat(3000) } }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(
      bad({ slug: 'ok', name: 'x', metadata: { a: { b: { c: { d: { e: 1 } } } } } }),
      'AXEDA_INVALID_INPUT',
    );
    await rejectsWith(bad({ slug: 'ok', name: 'x', managed: true }), 'AXEDA_INVALID_INPUT');
    await rejectsWith(bad(undefined), 'AXEDA_INVALID_INPUT');
    // http solo hacia la propia máquina (desarrollo)
    await f.axeda.companies.create(f.admin, {
      slug: 'dev',
      name: 'Dev',
      logoUrl: 'http://localhost:3000/logo.png',
    });
  });

  it('rejects a duplicate slug', async () => {
    const f = await createFixture();
    await f.axeda.companies.create(f.admin, { slug: 'acme', name: 'A' });
    await rejectsWith(
      f.axeda.companies.create(f.admin, { slug: 'acme', name: 'B' }),
      'AXEDA_SLUG_TAKEN',
    );
  });

  it('shows each person only the companies they belong to (404 for the rest)', async () => {
    const w = await world();
    const names = async (actor: typeof w.admin) =>
      (await w.axeda.companies.list(actor, {}, { limit: 10 })).items.map((c) => c.slug);

    expect(await names(w.admin)).toEqual(['a', 'b']);
    expect(await names(w.adminA)).toEqual(['a']);
    expect(await names(w.adminB)).toEqual(['b']);
    // quien solo tiene un negocio ve su compañía
    expect(await names(w.cashier)).toEqual(['a']);
    expect(await names(w.user('nobody'))).toEqual([]);

    expect((await w.axeda.companies.get(w.adminA, 'A')).slug).toBe('a');
    await rejectsWith(w.axeda.companies.get(w.adminA, 'B'), 'AXEDA_COMPANY_NOT_FOUND');
    await rejectsWith(w.axeda.companies.get(w.adminA, 'nope'), 'AXEDA_COMPANY_NOT_FOUND');
  });
});

describe('companies: who may change what', () => {
  it('lets a company admin edit their own company but not another, and not manage its lifecycle', async () => {
    const w = await world();
    const updated = await w.axeda.companies.update(w.adminA, 'A', 1, { name: 'ACME 2' });
    expect(updated).toMatchObject({ name: 'ACME 2', version: 2 });

    await rejectsWith(
      w.axeda.companies.update(w.adminA, 'B', 1, { name: 'hack' }),
      'AXEDA_COMPANY_NOT_FOUND',
    );
    for (const attempt of [
      () => w.axeda.companies.setStatus(w.adminA, 'A', 2, 'inactive'),
      () => w.axeda.companies.delete(w.adminA, 'A', 2),
      () => w.axeda.companies.delete(w.adminA, 'A', 2, { immediate: true }),
    ]) {
      await rejectsWith(attempt(), 'AXEDA_FORBIDDEN');
    }
    expect((await w.persistence.companies.get('A'))?.status).toBe('active');
  });

  it('denied attempts are audited, including the ones answered as 404', async () => {
    const w = await world();
    await w.axeda.companies.update(w.adminA, 'B', 1, { name: 'hack' }).catch(() => undefined);
    await w.axeda.companies.setStatus(w.adminA, 'A', 1, 'inactive').catch(() => undefined);
    const events = await w.axeda.listAudit(w.admin, { actorId: 'adminA' }, { limit: 10 });
    expect(events.items.map((e) => [e.action, e.outcome]).sort()).toEqual([
      ['company.set_status', 'denied'],
      ['company.update', 'denied'],
    ]);
  });

  it('applies optimistic concurrency', async () => {
    const w = await world();
    await w.axeda.companies.update(w.admin, 'A', 1, { name: 'first' });
    await rejectsWith(
      w.axeda.companies.update(w.admin, 'A', 1, { name: 'second' }),
      'AXEDA_VERSION_CONFLICT',
    );
  });

  it('rejects unknown fields, and does not accept changing the slug', async () => {
    const w = await world();
    await rejectsWith(
      w.axeda.companies.update(w.admin, 'A', 1, { slug: 'new' } as never),
      'AXEDA_INVALID_INPUT',
    );
  });
});

describe('a deactivated or deleted company stops granting power immediately', () => {
  const read = { type: 'company', companyId: 'A' } as const;

  it('when it is deactivated and reactivated', async () => {
    const w = await world();
    expect(await w.axeda.can(w.adminA, 'invoice:read', read)).toBe(true);
    expect(
      await w.axeda.can(w.cashier, 'invoice:read', {
        type: 'business',
        companyId: 'A',
        businessId: 'a1',
      }),
    ).toBe(true);

    const off = await w.axeda.companies.setStatus(w.admin, 'A', 1, 'inactive');
    expect(await w.axeda.can(w.adminA, 'invoice:read', read)).toBe(false);
    expect(
      await w.axeda.can(w.cashier, 'invoice:read', {
        type: 'business',
        companyId: 'A',
        businessId: 'a1',
      }),
    ).toBe(false);
    // Tampoco desde un administrador global: dentro de una compañía inactiva no se opera.
    expect(await w.axeda.can(w.admin, 'invoice:read', read)).toBe(false);
    expect(await w.axeda.scopesFor(w.adminA, 'invoice:read')).toEqual([]);
    expect(await w.axeda.scopeFilter(w.adminA, 'invoice:read')).toMatchObject({ companyIds: [] });

    await w.axeda.companies.setStatus(w.admin, 'A', off.version, 'active');
    expect(await w.axeda.can(w.adminA, 'invoice:read', read)).toBe(true);
  });

  it('when it is soft-deleted, and restoring brings everything back', async () => {
    const w = await world();
    expect(await w.axeda.can(w.adminA, 'invoice:read', read)).toBe(true);
    await w.axeda.companies.delete(w.admin, 'A', 1);
    expect(await w.axeda.can(w.adminA, 'invoice:read', read)).toBe(false);
    expect(
      await w.axeda.can(w.cashier, 'invoice:read', {
        type: 'business',
        companyId: 'A',
        businessId: 'a1',
      }),
    ).toBe(false);

    // Su propia gente ya no la ve; la plataforma sí, y solo ella la ve borrada.
    await rejectsWith(w.axeda.companies.get(w.adminA, 'A'), 'AXEDA_COMPANY_NOT_FOUND');
    expect(
      (await w.axeda.companies.list(w.admin, {}, { limit: 10 })).items.map((c) => c.slug),
    ).toEqual(['b']);
    const deleted = await w.axeda.companies.list(w.admin, { deleted: 'only' }, { limit: 10 });
    expect(deleted.items.map((c) => c.slug)).toEqual(['a']);
    await rejectsWith(
      w.axeda.companies.list(w.adminB, { deleted: 'include' }, { limit: 10 }),
      'AXEDA_FORBIDDEN',
    );

    const deletedCompany = deleted.items[0];
    await w.axeda.companies.restore(w.admin, 'A', deletedCompany?.version ?? 0);
    expect(await w.axeda.can(w.adminA, 'invoice:read', read)).toBe(true);
    expect((await w.axeda.companies.get(w.adminA, 'A')).deletedAt).toBeNull();
  });

  it('assignments cannot be created inside it, but the platform can still clean up there', async () => {
    const w = await world();
    const roleId = (await w.persistence.roles.getByKey('cashier'))?.id ?? '';
    await w.axeda.companies.setStatus(w.admin, 'A', 1, 'inactive');
    w.user('newcomer');
    await rejectsWith(
      w.axeda.assignments.assign(w.admin, {
        userId: 'newcomer',
        roleId,
        scope: { type: 'company', id: 'A' },
      }),
      'AXEDA_INVALID_INPUT',
    );
    const [assignment] = await w.persistence.assignments.listForUser('adminA');
    await w.axeda.assignments.revoke(w.admin, assignment?.id ?? '');
    expect(await w.persistence.assignments.listForUser('adminA')).toEqual([]);
  });

  it('the company of a business decides: a deleted company silences its businesses', async () => {
    const w = await world();
    const target = { type: 'business', companyId: 'A', businessId: 'a1' } as const;
    await w.axeda.companies.delete(w.admin, 'A', 1);
    expect(await w.axeda.can(w.cashier, 'invoice:read', target)).toBe(false);
    expect(await w.axeda.scopesFor(w.cashier, 'invoice:read')).toEqual([]);
  });
});

describe('the grace period and purging', () => {
  it('purges only what has been deleted for longer than the grace period, with everything that belongs to it', async () => {
    const w = await world();
    await w.axeda.companies.delete(w.admin, 'A', 1);
    expect(await w.axeda.purgeDeleted()).toEqual({ companies: 0, businesses: 0 });
    expect(await w.persistence.companies.get('A')).not.toBeNull();

    w.clock.current = new Date(w.clock.current.getTime() + 29 * DAY);
    expect((await w.axeda.purgeDeleted()).companies).toBe(0);

    w.clock.current = new Date(w.clock.current.getTime() + 2 * DAY);
    const result = await w.axeda.purgeDeleted();
    expect(result.companies).toBe(1);

    expect(await w.persistence.companies.get('A')).toBeNull();
    expect(await w.persistence.businesses.get('a1')).toBeNull();
    expect(await w.persistence.assignments.listForUser('adminA')).toEqual([]);
    expect(await w.persistence.assignments.listForUser('cashier')).toEqual([]);
    expect(await w.persistence.companies.get('B')).not.toBeNull();
    expect(await w.persistence.assignments.listForUser('adminB')).toHaveLength(1);

    const purged = await w.axeda.listAudit(w.admin, { action: 'company.purge' }, { limit: 5 });
    expect(purged.items[0]).toMatchObject({
      actorId: null,
      outcome: 'success',
      metadata: { slug: 'a' },
    });
  });

  it('honours a custom grace period', async () => {
    const f = await createFixture({ permissions: ['a:b'], retention: { graceDays: 2 } });
    await f.company('A');
    await f.axeda.companies.delete(f.admin, 'A', 1);
    f.clock.current = new Date(f.clock.current.getTime() + 3 * DAY);
    expect((await f.axeda.purgeDeleted()).companies).toBe(1);
  });

  it('deleting immediately (privacy requests) skips the grace period but needs a platform administrator', async () => {
    const w = await world();
    await rejectsWith(
      w.axeda.companies.delete(w.adminB, 'B', 1, { immediate: true }),
      'AXEDA_FORBIDDEN',
    );
    await w.axeda.companies.delete(w.admin, 'B', 1, { immediate: true });
    expect(await w.persistence.companies.get('B')).toBeNull();
    expect(await w.persistence.businesses.get('b1')).toBeNull();
    expect(await w.persistence.assignments.listForUser('adminB')).toEqual([]);
    const events = await w.axeda.listAudit(w.admin, { action: 'company.purge' }, { limit: 5 });
    expect(events.items.map((event) => [event.actorId, event.outcome]).sort()).toEqual([
      ['admin', 'success'],
      ['adminB', 'denied'],
    ]);
  });

  it('refuses to delete twice or to restore something that is not deleted', async () => {
    const w = await world();
    await rejectsWith(w.axeda.companies.restore(w.admin, 'A', 1), 'AXEDA_INVALID_INPUT');
    const deleted = await (async () => {
      await w.axeda.companies.delete(w.admin, 'A', 1);
      return w.persistence.companies.get('A');
    })();
    await rejectsWith(
      w.axeda.companies.delete(w.admin, 'A', deleted?.version ?? 0),
      'AXEDA_INVALID_INPUT',
    );
  });
});

describe('businesses', () => {
  it('lets a company admin create businesses in their company only', async () => {
    const w = await world();
    const created = await w.axeda.businesses.create(w.adminA, 'A', { slug: 'shop', name: 'Shop' });
    expect(created).toMatchObject({ companyId: 'A', slug: 'shop', status: 'active' });
    await rejectsWith(
      w.axeda.businesses.create(w.adminA, 'B', { slug: 'x', name: 'X' }),
      'AXEDA_COMPANY_NOT_FOUND',
    );
    await rejectsWith(
      w.axeda.businesses.create(w.user('nobody'), 'A', { slug: 'x', name: 'X' }),
      'AXEDA_COMPANY_NOT_FOUND',
    );
    await rejectsWith(
      w.axeda.businesses.create(w.cashier, 'A', { slug: 'x', name: 'X' }),
      'AXEDA_FORBIDDEN',
    );
    await rejectsWith(
      w.axeda.businesses.create(w.adminA, 'A', { slug: 'shop', name: 'again' }),
      'AXEDA_SLUG_TAKEN',
    );
  });

  it('never trusts the company from the request: the business decides', async () => {
    const w = await world();
    // a1 es de la compañía A; adminB no puede tocarlo aunque la petición mencione B.
    await rejectsWith(
      w.axeda.businesses.update(w.adminB, 'a1', 1, { name: 'hack' }),
      'AXEDA_BUSINESS_NOT_FOUND',
    );
    await rejectsWith(
      w.axeda.businesses.setStatus(w.adminB, 'a1', 1, 'inactive'),
      'AXEDA_BUSINESS_NOT_FOUND',
    );
    await rejectsWith(w.axeda.businesses.delete(w.adminB, 'a1', 1), 'AXEDA_BUSINESS_NOT_FOUND');
    expect((await w.persistence.businesses.get('a1'))?.status).toBe('active');
    expect((await w.axeda.businesses.update(w.adminA, 'a1', 1, { name: 'Renamed' })).name).toBe(
      'Renamed',
    );
  });

  it('shows a business-only member just their business, and a company admin all of them', async () => {
    const w = await world();
    await w.axeda.businesses.create(w.adminA, 'A', { slug: 'second', name: 'Second' });
    const slugs = async (actor: typeof w.admin) =>
      (await w.axeda.businesses.list(actor, 'A', {}, { limit: 10 })).items.map((b) => b.slug);
    expect(await slugs(w.adminA)).toEqual(['a1', 'second']);
    expect(await slugs(w.cashier)).toEqual(['a1']);
    expect(await slugs(w.admin)).toEqual(['a1', 'second']);
    await rejectsWith(
      w.axeda.businesses.list(w.adminB, 'A', {}, { limit: 10 }),
      'AXEDA_COMPANY_NOT_FOUND',
    );
    expect((await w.axeda.businesses.get(w.cashier, 'a1')).slug).toBe('a1');
    await rejectsWith(w.axeda.businesses.get(w.adminB, 'a1'), 'AXEDA_BUSINESS_NOT_FOUND');
  });

  it('deactivating, deleting and restoring a business takes effect at once', async () => {
    const w = await world();
    const target = { type: 'business', companyId: 'A', businessId: 'a1' } as const;
    expect(await w.axeda.can(w.cashier, 'invoice:read', target)).toBe(true);

    const off = await w.axeda.businesses.setStatus(w.adminA, 'a1', 1, 'inactive');
    expect(await w.axeda.can(w.cashier, 'invoice:read', target)).toBe(false);
    // el resto de la compañía no se ve afectado
    expect(await w.axeda.can(w.adminA, 'invoice:read', { type: 'company', companyId: 'A' })).toBe(
      true,
    );

    const on = await w.axeda.businesses.setStatus(w.adminA, 'a1', off.version, 'active');
    expect(await w.axeda.can(w.cashier, 'invoice:read', target)).toBe(true);

    await w.axeda.businesses.delete(w.adminA, 'a1', on.version);
    expect(await w.axeda.can(w.cashier, 'invoice:read', target)).toBe(false);
    const gone = await w.persistence.businesses.get('a1');
    await w.axeda.businesses.restore(w.adminA, 'a1', gone?.version ?? 0);
    expect(await w.axeda.can(w.cashier, 'invoice:read', target)).toBe(true);
  });

  it('cannot be created in an inactive company, and is purged with the grace period', async () => {
    const w = await world();
    await w.axeda.companies.setStatus(w.admin, 'B', 1, 'inactive');
    await rejectsWith(
      w.axeda.businesses.create(w.admin, 'B', { slug: 'new', name: 'New' }),
      'AXEDA_INVALID_INPUT',
    );

    await w.axeda.businesses.delete(w.adminA, 'a1', 1);
    w.clock.current = new Date(w.clock.current.getTime() + 31 * DAY);
    expect((await w.axeda.purgeDeleted()).businesses).toBe(1);
    expect(await w.persistence.businesses.get('a1')).toBeNull();
    expect(await w.persistence.assignments.listForUser('cashier')).toEqual([]);
    expect(await w.persistence.companies.get('A')).not.toBeNull();
  });
});

describe('public identity', () => {
  it('shows name and logos of active, undeleted companies and businesses only', async () => {
    const f = await createFixture();
    const company = await f.axeda.companies.create(f.admin, {
      slug: 'acme',
      name: 'ACME',
      logoUrl: 'https://cdn.example/a.png',
      metadata: { secret: 'x' },
    });
    await f.axeda.businesses.create(f.admin, company.id, { slug: 'shop', name: 'Shop' });

    expect(await f.axeda.publicIdentity({ company: 'acme' })).toEqual({
      kind: 'company',
      slug: 'acme',
      name: 'ACME',
      logoUrl: 'https://cdn.example/a.png',
      faviconUrl: null,
    });
    expect(await f.axeda.publicIdentity({ company: 'acme', business: 'shop' })).toMatchObject({
      kind: 'business',
      name: 'Shop',
      company: { slug: 'acme', name: 'ACME' },
    });
  });

  it('answers null for unknown, inactive and deleted ones, without telling them apart', async () => {
    const f = await createFixture();
    const company = await f.axeda.companies.create(f.admin, { slug: 'acme', name: 'ACME' });
    const shop = await f.axeda.businesses.create(f.admin, company.id, {
      slug: 'shop',
      name: 'Shop',
    });
    expect(await f.axeda.publicIdentity({ company: 'nope' })).toBeNull();
    expect(await f.axeda.publicIdentity({ company: 'acme', business: 'nope' })).toBeNull();

    const off = await f.axeda.businesses.setStatus(f.admin, shop.id, 1, 'inactive');
    expect(await f.axeda.publicIdentity({ company: 'acme', business: 'shop' })).toBeNull();
    await f.axeda.businesses.setStatus(f.admin, shop.id, off.version, 'active');
    expect(await f.axeda.publicIdentity({ company: 'acme', business: 'shop' })).not.toBeNull();

    await f.axeda.companies.setStatus(f.admin, company.id, 1, 'inactive');
    expect(await f.axeda.publicIdentity({ company: 'acme' })).toBeNull();
    expect(await f.axeda.publicIdentity({ company: 'acme', business: 'shop' })).toBeNull();
  });

  it('never exposes anything beyond the whitelist', async () => {
    const f = await createFixture();
    await f.axeda.companies.create(f.admin, {
      slug: 'acme',
      name: 'ACME',
      legalName: 'Secret Legal Name',
      metadata: { internal: 'x' },
    });
    const identity = await f.axeda.publicIdentity({ company: 'acme' });
    expect(Object.keys(identity ?? {}).sort()).toEqual([
      'faviconUrl',
      'kind',
      'logoUrl',
      'name',
      'slug',
    ]);
  });
});
