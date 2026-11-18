import { describe, expect, it } from 'vitest';
import { isAxedaError, type AssignmentScope, type AxedaErrorCode } from '../src/index.js';
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
const site = (id: string): AssignmentScope => ({ type: 'site', id });

/**
 * Compañía A con un negocio `a1` (y otro `a2`), una sede directa `sa` y dos sedes del negocio
 * (`s1`, `s2`); una sede `s3` del negocio `a2`; la compañía B con su sede `sb`.
 */
async function world() {
  const f = await createFixture();
  await f.company('A');
  await f.company('B');
  await f.business('a1', 'A');
  await f.business('a2', 'A');
  await f.site('sa', 'A');
  await f.site('s1', 'A', 'a1');
  await f.site('s2', 'A', 'a1');
  await f.site('s3', 'A', 'a2');
  await f.site('sb', 'B');
  await f.role('reader', ['invoice:read']);
  // Quien lleva una sede: concede funciones e invita en ella, pero no administra la sede en sí.
  await f.role('site-manager', ['axeda:assignment:manage', 'axeda:invitation:manage', 'invoice:*']);
  await f.role('site-admin', [
    'axeda:site:manage',
    'axeda:assignment:manage',
    'axeda:invitation:manage',
    'invoice:*',
  ]);
  return f;
}

/** ¿Puede `userId` leer facturas en ese alcance (resuelto desde la base de datos)? */
async function canRead(
  f: Awaited<ReturnType<typeof world>>,
  userId: string,
  scope: AssignmentScope,
) {
  const target = await f.axeda.resolveTarget(scope);
  if (target === null) return false;
  return f.axeda.can({ userId }, 'invoice:read', target);
}

describe('sites: where an assignment applies', () => {
  it('resolves a site with its company and business from the database', async () => {
    const f = await world();
    expect(await f.axeda.resolveTarget(site('s1'))).toEqual({
      type: 'site',
      companyId: 'A',
      businessId: 'a1',
      siteId: 's1',
    });
    expect(await f.axeda.resolveTarget(site('sa'))).toEqual({
      type: 'site',
      companyId: 'A',
      businessId: null,
      siteId: 'sa',
    });
    expect(await f.axeda.resolveTarget(site('nope'))).toBeNull();
  });

  it('a company assignment applies to every site of the company, with or without a business', async () => {
    const f = await world();
    f.user('ana');
    await f.give('ana', 'reader', { type: 'company', id: 'A' });
    for (const id of ['sa', 's1', 's2', 's3']) expect(await canRead(f, 'ana', site(id))).toBe(true);
    expect(await canRead(f, 'ana', site('sb'))).toBe(false);
  });

  it('a business assignment applies to the sites of that business only', async () => {
    const f = await world();
    f.user('bea');
    await f.give('bea', 'reader', { type: 'business', id: 'a1' });
    expect(await canRead(f, 'bea', site('s1'))).toBe(true);
    expect(await canRead(f, 'bea', site('s2'))).toBe(true);
    expect(await canRead(f, 'bea', site('s3'))).toBe(false);
    // Una sede que cuelga directamente de la compañía no hereda de ningún negocio.
    expect(await canRead(f, 'bea', site('sa'))).toBe(false);
  });

  it('a site assignment applies to that site only, not to its business, company or siblings', async () => {
    const f = await world();
    f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    expect(await canRead(f, 'cy', site('s1'))).toBe(true);
    expect(await canRead(f, 'cy', site('s2'))).toBe(false);
    expect(await canRead(f, 'cy', { type: 'business', id: 'a1' })).toBe(false);
    expect(await canRead(f, 'cy', { type: 'company', id: 'A' })).toBe(false);
  });

  it('lists the sites where someone has a permission, for filtering queries', async () => {
    const f = await world();
    f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    await f.give('cy', 'reader', site('sb'));
    expect(await f.axeda.scopeFilter({ userId: 'cy' }, 'invoice:read')).toEqual({
      unrestricted: false,
      companyIds: [],
      businessIds: [],
      siteIds: ['s1', 'sb'],
    });
  });
});

describe('sites: blocked by what they hang from', () => {
  it('an inactive site grants nothing, and comes back when reactivated', async () => {
    const f = await world();
    f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    const s1 = await f.axeda.sites.get(f.admin, 's1');
    const off = await f.axeda.sites.setStatus(f.admin, 's1', s1.version, 'inactive');
    expect(await canRead(f, 'cy', site('s1'))).toBe(false);
    await f.axeda.sites.setStatus(f.admin, 's1', off.version, 'active');
    expect(await canRead(f, 'cy', site('s1'))).toBe(true);
  });

  it('a deleted business blocks its sites, also for a company administrator, until restored', async () => {
    const f = await world();
    f.user('cy');
    f.user('ana');
    await f.give('cy', 'reader', site('s1'));
    await f.give('ana', 'reader', { type: 'company', id: 'A' });
    const a1 = await f.axeda.businesses.get(f.admin, 'a1');
    await f.axeda.businesses.delete(f.admin, 'a1', a1.version);
    expect(await canRead(f, 'cy', site('s1'))).toBe(false);
    expect(await canRead(f, 'ana', site('s1'))).toBe(false);
    // La sede directa de la compañía no depende de ese negocio.
    expect(await canRead(f, 'ana', site('sa'))).toBe(true);

    const deleted = await f.axeda.businesses.get(f.admin, 'a1');
    await f.axeda.businesses.restore(f.admin, 'a1', deleted.version);
    expect(await canRead(f, 'cy', site('s1'))).toBe(true);
  });

  it('a blocked business also drops its sites from the scopes where someone holds a permission', async () => {
    const f = await world();
    f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    await f.give('cy', 'reader', site('sa'));
    const a1 = await f.axeda.businesses.get(f.admin, 'a1');
    await f.axeda.businesses.setStatus(f.admin, 'a1', a1.version, 'inactive');
    // Sin destino que comprobar, solo cuenta si la asignación sigue viva.
    expect((await f.axeda.scopeFilter({ userId: 'cy' }, 'invoice:read')).siteIds).toEqual(['sa']);
    await f.axeda.sites
      .get(f.admin, 'sa')
      .then((sa) => f.axeda.sites.setStatus(f.admin, 'sa', sa.version, 'inactive'));
    expect(await f.axeda.canAnywhere({ userId: 'cy' }, 'invoice:read')).toBe(false);
  });

  it('an inactive company blocks all its sites', async () => {
    const f = await world();
    f.user('cy');
    await f.give('cy', 'reader', site('sa'));
    const a = await f.axeda.companies.get(f.admin, 'A');
    await f.axeda.companies.setStatus(f.admin, 'A', a.version, 'inactive');
    expect(await canRead(f, 'cy', site('sa'))).toBe(false);
  });
});

describe('sites: creating them', () => {
  it('a company administrator creates sites under the company or under one of its businesses', async () => {
    const f = await world();
    f.user('ana');
    await f.give('ana', 'site-admin', { type: 'company', id: 'A' });
    const ana = f.user('ana');
    const direct = await f.axeda.sites.create(ana, 'A', { slug: 'north', name: 'North' });
    expect(direct).toMatchObject({
      companyId: 'A',
      businessId: null,
      version: 1,
      status: 'active',
    });
    const inBusiness = await f.axeda.sites.create(ana, 'A', {
      slug: 'south',
      name: 'South',
      businessId: 'a1',
    });
    expect(inBusiness).toMatchObject({ companyId: 'A', businessId: 'a1' });
    const [event] = (await f.axeda.listAudit(f.admin, { action: 'site.create' }, { limit: 1 }))
      .items;
    expect(event).toMatchObject({
      targetType: 'site',
      targetId: inBusiness.id,
      scope: site(inBusiness.id),
      metadata: { slug: 'south', companyId: 'A', businessId: 'a1' },
    });
  });

  it('a business administrator creates sites only in that business', async () => {
    const f = await world();
    const bo = f.user('bo');
    await f.give('bo', 'site-admin', { type: 'business', id: 'a1' });
    await expect(
      f.axeda.sites.create(bo, 'A', { slug: 'east', name: 'East', businessId: 'a1' }),
    ).resolves.toMatchObject({ businessId: 'a1' });
    await rejectsWith(f.axeda.sites.create(bo, 'A', { slug: 'w', name: 'W' }), 'AXEDA_FORBIDDEN');
    await rejectsWith(
      f.axeda.sites.create(bo, 'A', { slug: 'w', name: 'W', businessId: 'a2' }),
      'AXEDA_FORBIDDEN',
    );
  });

  it('refuses a business of another company as if it did not exist', async () => {
    const f = await world();
    await f.business('b1', 'B');
    await rejectsWith(
      f.axeda.sites.create(f.admin, 'A', { slug: 'x', name: 'X', businessId: 'b1' }),
      'AXEDA_BUSINESS_NOT_FOUND',
    );
  });

  it('authorizes before validating: someone without the permission learns nothing', async () => {
    const f = await world();
    const cy = f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    for (const input of [
      { slug: 'sa', name: 'taken' },
      { slug: 'Bad Slug', name: 'x' },
      { slug: 'ok', name: 'x', surprise: 1 },
    ]) {
      await rejectsWith(f.axeda.sites.create(cy, 'A', input as never), 'AXEDA_FORBIDDEN');
    }
    // Quien no ve la compañía ni siquiera sabe que existe.
    const stranger = f.user('stranger');
    await rejectsWith(
      f.axeda.sites.create(stranger, 'A', { slug: 'x', name: 'X' }),
      'AXEDA_COMPANY_NOT_FOUND',
    );
  });

  it('keeps slugs unique per company, whether the site hangs from a business or not', async () => {
    const f = await world();
    await rejectsWith(
      f.axeda.sites.create(f.admin, 'A', { slug: 's1', name: 'Again' }),
      'AXEDA_SLUG_TAKEN',
    );
    await expect(
      f.axeda.sites.create(f.admin, 'B', { slug: 's1', name: 'Other company' }),
    ).resolves.toMatchObject({ companyId: 'B' });
  });

  it('refuses to create a site under an inactive business', async () => {
    const f = await world();
    const a2 = await f.axeda.businesses.get(f.admin, 'a2');
    await f.axeda.businesses.setStatus(f.admin, 'a2', a2.version, 'inactive');
    await rejectsWith(
      f.axeda.sites.create(f.admin, 'A', { slug: 'x', name: 'X', businessId: 'a2' }),
      'AXEDA_INVALID_INPUT',
    );
  });
});

describe('sites: who sees them', () => {
  const slugs = (page: { items: readonly { slug: string }[] }) => page.items.map((s) => s.slug);

  it('lists every site to a company member, and only their own to the others', async () => {
    const f = await world();
    const ana = f.user('ana');
    const bea = f.user('bea');
    const cy = f.user('cy');
    await f.give('ana', 'reader', { type: 'company', id: 'A' });
    await f.give('bea', 'reader', { type: 'business', id: 'a1' });
    await f.give('cy', 'reader', site('s3'));
    const page = { limit: 50 };
    expect(slugs(await f.axeda.sites.list(ana, 'A', {}, page))).toEqual(['s1', 's2', 's3', 'sa']);
    expect(slugs(await f.axeda.sites.list(bea, 'A', {}, page))).toEqual(['s1', 's2']);
    expect(slugs(await f.axeda.sites.list(cy, 'A', {}, page))).toEqual(['s3']);
    await rejectsWith(f.axeda.sites.list(cy, 'B', {}, page), 'AXEDA_COMPANY_NOT_FOUND');
  });

  it('filters by business, or by sites that hang directly from the company', async () => {
    const f = await world();
    const page = { limit: 50 };
    expect(slugs(await f.axeda.sites.list(f.admin, 'A', { businessId: 'a1' }, page))).toEqual([
      's1',
      's2',
    ]);
    expect(slugs(await f.axeda.sites.list(f.admin, 'A', { businessId: null }, page))).toEqual([
      'sa',
    ]);
  });

  it('hides a site from someone who cannot see it, as if it did not exist', async () => {
    const f = await world();
    const cy = f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    await expect(f.axeda.sites.get(cy, 's1')).resolves.toMatchObject({ slug: 's1' });
    await rejectsWith(f.axeda.sites.get(cy, 's2'), 'AXEDA_SITE_NOT_FOUND');
  });

  it('lets an employee see their site but not change it', async () => {
    const f = await world();
    const cy = f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    const s1 = await f.axeda.sites.get(cy, 's1');
    await rejectsWith(f.axeda.sites.update(cy, 's1', s1.version, { name: 'X' }), 'AXEDA_FORBIDDEN');
  });
});

describe('sites: employees are assignments in the site', () => {
  it('a site manager grants roles in their site, never more than they hold', async () => {
    const f = await world();
    const manager = f.user('manager');
    f.user('worker');
    await f.give('manager', 'site-manager', site('s1'));
    const reader = await f.axeda.roles.create(f.admin, {
      key: 'shift',
      name: 'Shift',
      permissions: ['invoice:read'],
    });
    const created = await f.axeda.assignments.assign(manager, {
      userId: 'worker',
      roleId: reader.id,
      scope: site('s1'),
    });
    expect(created.scope).toEqual(site('s1'));
    // En otra sede no administra nada.
    await rejectsWith(
      f.axeda.assignments.assign(manager, {
        userId: 'worker',
        roleId: reader.id,
        scope: site('s2'),
      }),
      'AXEDA_FORBIDDEN',
    );
    const employees = await f.axeda.assignments.listForScope(manager, site('s1'), { limit: 50 });
    expect(employees.items.map((a) => a.userId).sort()).toEqual(['manager', 'worker']);
  });

  it('refuses to grant a company-wide Axeda permission in a site', async () => {
    const f = await world();
    f.user('worker');
    const role = await f.axeda.roles.create(f.admin, {
      key: 'too-much',
      name: 'Too much',
      permissions: ['axeda:company:manage'],
    });
    const error = await rejectsWith(
      f.axeda.assignments.assign(f.admin, { userId: 'worker', roleId: role.id, scope: site('s1') }),
      'AXEDA_FORBIDDEN',
    );
    expect(error.details).toMatchObject({ reason: 'permission_not_valid_in_scope' });
  });

  it('shows a business manager the assignments in the sites of that business', async () => {
    const f = await world();
    const bo = f.user('bo');
    f.user('cy');
    await f.give('bo', 'site-admin', { type: 'business', id: 'a1' });
    await f.give('cy', 'reader', site('s1'));
    await f.give('cy', 'reader', site('s3'));
    const seen = await f.axeda.assignments.listForUser(bo, 'cy');
    expect(seen.map((a) => a.scope)).toEqual([site('s1')]);
  });
});

describe('sites: deleting and purging', () => {
  it('purging a business takes its sites and their assignments with it', async () => {
    const f = await world();
    f.user('cy');
    await f.give('cy', 'reader', site('s1'));
    const a1 = await f.axeda.businesses.get(f.admin, 'a1');
    await f.axeda.businesses.delete(f.admin, 'a1', a1.version, { immediate: true });
    expect(await f.persistence.sites.get('s1')).toBeNull();
    expect(await f.persistence.sites.get('s2')).toBeNull();
    expect(await f.persistence.sites.get('sa')).not.toBeNull();
    expect(await f.persistence.assignments.listForUser('cy')).toEqual([]);
  });

  it('purges a site after its grace period, and audits it', async () => {
    const f = await world();
    const sa = await f.axeda.sites.get(f.admin, 'sa');
    await f.axeda.sites.delete(f.admin, 'sa', sa.version);
    expect(await f.axeda.purgeDeleted()).toEqual({
      companies: 0,
      businesses: 0,
      sites: 0,
      images: 0,
    });
    f.clock.current = new Date(f.clock.current.getTime() + 31 * DAY);
    expect(await f.axeda.purgeDeleted()).toEqual({
      companies: 0,
      businesses: 0,
      sites: 1,
      images: 0,
    });
    expect(await f.persistence.sites.get('sa')).toBeNull();
    const [event] = (await f.axeda.listAudit(f.admin, { action: 'site.purge' }, { limit: 1 }))
      .items;
    expect(event).toMatchObject({ targetType: 'site', targetId: 'sa', actorId: null });
  });

  it('only a platform administrator can list deleted sites', async () => {
    const f = await world();
    const ana = f.user('ana');
    await f.give('ana', 'site-admin', { type: 'company', id: 'A' });
    await rejectsWith(
      f.axeda.sites.list(ana, 'A', { deleted: 'include' }, { limit: 5 }),
      'AXEDA_FORBIDDEN',
    );
  });
});
