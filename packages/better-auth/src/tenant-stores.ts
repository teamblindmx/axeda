import {
  AxedaError,
  scopeKey,
  type AssignmentScope,
  type Business,
  type BusinessChanges,
  type BusinessStore,
  type Company,
  type CompanyChanges,
  type CompanyStore,
  type InvitationStore,
  type NewBusiness,
  type NewCompany,
  type NewInvitation,
  type Page,
  type PageRequest,
  type NewSite,
  type Site,
  type SiteChanges,
  type SiteFilter,
  type SiteStore,
  type StoredInvitation,
  type TenantFilter,
  type TenantStatus,
  withoutSecret,
} from '@teamblind/axeda-core';
import { isForeignKeyViolation, isUniqueViolation } from './errors.js';
import { scopeColumns, toScope } from './rows.js';
import { MODELS } from './schema.js';
import { byId, decodeCursor, encodeCursor, MAX_ROWS, type Adapter, type Atomic } from './shared.js';

// ---------- filas ----------

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  status: string;
  metadata: Record<string, unknown>;
  version: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface CompanyRow extends TenantRow {
  legalName?: string | null;
}
interface BusinessRow extends TenantRow {
  companyId: string;
}
interface SiteRow extends TenantRow {
  companyId: string;
  businessId?: string | null;
}
interface InvitationRow {
  id: string;
  email: string;
  scopeType: string;
  scopeId: string;
  roleIds: string[];
  invitedBy: string;
  secretHash: string;
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  createdAt: Date;
}

const tenantBase = (row: TenantRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  logoUrl: row.logoUrl ?? null,
  faviconUrl: row.faviconUrl ?? null,
  // Un estado desconocido se trata como inactivo: ante la duda, no concede nada.
  status: (row.status === 'active' ? 'active' : 'inactive') as TenantStatus,
  metadata: row.metadata,
  version: row.version,
  deletedAt: row.deletedAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toCompany = (row: CompanyRow): Company => ({
  ...tenantBase(row),
  legalName: row.legalName ?? null,
});
const toBusiness = (row: BusinessRow): Business => ({
  ...tenantBase(row),
  companyId: row.companyId,
});
const toSite = (row: SiteRow): Site => ({
  ...tenantBase(row),
  companyId: row.companyId,
  businessId: row.businessId ?? null,
});
const toInvitation = (row: InvitationRow): StoredInvitation => ({
  id: row.id,
  email: row.email,
  scope: toScope({ id: row.id, scopeType: row.scopeType, scopeId: row.scopeId }),
  roleIds: row.roleIds,
  invitedBy: row.invitedBy,
  secretHash: row.secretHash,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  acceptedAt: row.acceptedAt ?? null,
  revokedAt: row.revokedAt ?? null,
});

// ---------- ayudas comunes ----------

type Where = {
  field: string;
  value: string | number | boolean | string[] | Date | null;
  operator?: 'in' | 'gt' | 'lt' | 'ne';
  connector?: 'AND' | 'OR';
};

/** Condiciones del filtro de borrados y de identificadores. */
function filterWhere(filter: TenantFilter): Where[] {
  const where: Where[] = [];
  const deleted = filter.deleted ?? 'exclude';
  if (deleted === 'exclude') where.push({ field: 'deletedAt', value: null });
  if (deleted === 'only') where.push({ field: 'deletedAt', operator: 'ne', value: null });
  if (filter.ids !== undefined) where.push({ field: 'id', operator: 'in', value: [...filter.ids] });
  return where;
}

/**
 * Cambio con la versión como guarda (`incrementOne`): de dos escritores con la misma versión solo
 * uno la cumple. Si no cambia nada se distingue «no existe» de «versión distinta».
 */
async function guarded<Row>(
  adapter: Adapter,
  model: string,
  id: string,
  expectedVersion: number,
  set: Record<string, unknown>,
  now: () => Date,
  missing: () => AxedaError,
): Promise<Row> {
  const updated = await adapter.incrementOne<Row>({
    model,
    where: [
      { field: 'id', value: id },
      { field: 'version', value: expectedVersion },
    ],
    increment: { version: 1 },
    set: { ...set, updatedAt: now() },
  });
  if (updated) return updated;
  const current = await adapter.findOne<{ version: number }>({ model, where: byId(id) });
  if (!current) throw missing();
  throw new AxedaError(
    'AXEDA_VERSION_CONFLICT',
    `"${id}" is at version ${current.version}, not ${expectedVersion}.`,
  );
}

const defined = <T extends Record<string, unknown>>(values: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

async function pageOf<Row extends { id: string }, T>(
  adapter: Adapter,
  model: string,
  where: Where[],
  sortField: 'slug' | 'id',
  sortKey: (row: Row) => string,
  page: PageRequest,
  map: (row: Row) => T,
): Promise<Page<T>> {
  const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
  const rows = await adapter.findMany<Row>({
    model,
    where: [
      ...where,
      ...(after === null ? [] : [{ field: sortField, operator: 'gt' as const, value: after }]),
    ],
    sortBy: { field: sortField, direction: 'asc' },
    limit: page.limit + 1,
  });
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor: rows.length > page.limit && last ? encodeCursor(sortKey(last)) : null,
  };
}

const emptyPage = <T>(): Page<T> => ({ items: [], nextCursor: null });

/** Borra de verdad las asignaciones e invitaciones de estos alcances. */
async function dropScopes(
  adapter: Adapter,
  scopeType: 'company' | 'business' | 'site',
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const where = [
    { field: 'scopeType', value: scopeType },
    { field: 'scopeId', operator: 'in' as const, value: [...ids] },
  ];
  await adapter.deleteMany({ model: MODELS.assignment, where });
  await adapter.deleteMany({ model: MODELS.invitation, where });
}

/**
 * Borra de verdad las sedes cuyo `field` está en `ids` (las de unas compañías, unos negocios o
 * esas mismas sedes), con las asignaciones e invitaciones de su alcance. Devuelve cuántas.
 */
async function purgeSitesWhere(
  adapter: Adapter,
  field: 'id' | 'companyId' | 'businessId',
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const where = [{ field, operator: 'in' as const, value: [...ids] }];
  const sites = await adapter.findMany<{ id: string }>({
    model: MODELS.site,
    where,
    limit: MAX_ROWS,
  });
  await dropScopes(
    adapter,
    'site',
    sites.map((site) => site.id),
  );
  return adapter.deleteMany({ model: MODELS.site, where });
}

// ---------- compañías ----------

export function createCompanyStore(
  adapter: Adapter,
  atomic: Atomic,
  now: () => Date,
): CompanyStore {
  const model = MODELS.company;
  const missing = (id: string) => () =>
    new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${id}" does not exist.`);

  return {
    async get(id) {
      const row = await adapter.findOne<CompanyRow>({ model, where: byId(id) });
      return row ? toCompany(row) : null;
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      const rows = await adapter.findMany<CompanyRow>({
        model,
        where: [{ field: 'id', operator: 'in', value: [...ids] }],
        limit: ids.length,
      });
      return rows.map(toCompany);
    },
    async getBySlug(slug) {
      const row = await adapter.findOne<CompanyRow>({
        model,
        where: [{ field: 'slug', value: slug }],
      });
      return row ? toCompany(row) : null;
    },
    async list(filter, page) {
      if (filter.ids?.length === 0) return emptyPage();
      return pageOf<CompanyRow, Company>(
        adapter,
        model,
        filterWhere(filter),
        'slug',
        (row) => row.slug,
        page,
        toCompany,
      );
    },
    async create(input: NewCompany) {
      const taken = () =>
        new AxedaError('AXEDA_SLUG_TAKEN', `A company with slug "${input.slug}" already exists.`);
      if (await adapter.findOne({ model, where: [{ field: 'slug', value: input.slug }] }))
        throw taken();
      const at = now();
      try {
        const row = await adapter.create<Omit<CompanyRow, 'id'>, CompanyRow>({
          model,
          data: {
            slug: input.slug,
            name: input.name,
            legalName: input.legalName ?? null,
            logoUrl: input.logoUrl ?? null,
            faviconUrl: input.faviconUrl ?? null,
            status: 'active',
            metadata: { ...(input.metadata ?? {}) },
            version: 1,
            deletedAt: null,
            createdAt: at,
            updatedAt: at,
          },
        });
        return toCompany(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw taken();
        throw error;
      }
    },
    async update(id, expectedVersion, changes: CompanyChanges) {
      const set = defined({
        name: changes.name,
        legalName: changes.legalName,
        logoUrl: changes.logoUrl,
        faviconUrl: changes.faviconUrl,
        metadata: changes.metadata === undefined ? undefined : { ...changes.metadata },
      });
      return toCompany(
        await guarded<CompanyRow>(adapter, model, id, expectedVersion, set, now, missing(id)),
      );
    },
    async setStatus(id, expectedVersion, status) {
      return toCompany(
        await guarded<CompanyRow>(
          adapter,
          model,
          id,
          expectedVersion,
          { status },
          now,
          missing(id),
        ),
      );
    },
    async setDeleted(id, expectedVersion, at) {
      return toCompany(
        await guarded<CompanyRow>(
          adapter,
          model,
          id,
          expectedVersion,
          { deletedAt: at },
          now,
          missing(id),
        ),
      );
    },
    async listDeletedBefore(before, limit) {
      const rows = await adapter.findMany<CompanyRow>({
        model,
        where: [{ field: 'deletedAt', operator: 'lt', value: before }],
        sortBy: { field: 'slug', direction: 'asc' },
        limit,
      });
      return rows.map(toCompany);
    },
    purge: (ids) =>
      ids.length === 0
        ? Promise.resolve(0)
        : atomic(async (trx) => {
            const businesses = await trx.findMany<BusinessRow>({
              model: MODELS.business,
              where: [{ field: 'companyId', operator: 'in', value: [...ids] }],
              limit: MAX_ROWS,
            });
            await dropScopes(
              trx,
              'business',
              businesses.map((business) => business.id),
            );
            await dropScopes(trx, 'company', ids);
            await purgeSitesWhere(trx, 'companyId', ids);
            await trx.deleteMany({
              model: MODELS.business,
              where: [{ field: 'companyId', operator: 'in', value: [...ids] }],
            });
            return trx.deleteMany({
              model,
              where: [{ field: 'id', operator: 'in', value: [...ids] }],
            });
          }),
  };
}

// ---------- negocios ----------

export function createBusinessStore(
  adapter: Adapter,
  atomic: Atomic,
  now: () => Date,
): BusinessStore {
  const model = MODELS.business;
  const missing = (id: string) => () =>
    new AxedaError('AXEDA_BUSINESS_NOT_FOUND', `Business "${id}" does not exist.`);

  return {
    async get(id) {
      const row = await adapter.findOne<BusinessRow>({ model, where: byId(id) });
      return row ? toBusiness(row) : null;
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      const rows = await adapter.findMany<BusinessRow>({
        model,
        where: [{ field: 'id', operator: 'in', value: [...ids] }],
        limit: ids.length,
      });
      return rows.map(toBusiness);
    },
    async getBySlug(companyId, slug) {
      const row = await adapter.findOne<BusinessRow>({
        model,
        where: [
          { field: 'companyId', value: companyId },
          { field: 'slug', value: slug },
        ],
      });
      return row ? toBusiness(row) : null;
    },
    async listForCompany(companyId, filter, page) {
      if (filter.ids?.length === 0) return emptyPage();
      return pageOf<BusinessRow, Business>(
        adapter,
        model,
        [{ field: 'companyId', value: companyId }, ...filterWhere(filter)],
        'slug',
        (row) => row.slug,
        page,
        toBusiness,
      );
    },
    async create(input: NewBusiness) {
      const taken = () =>
        new AxedaError(
          'AXEDA_SLUG_TAKEN',
          `A business with slug "${input.slug}" already exists in that company.`,
        );
      const noCompany = () =>
        new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${input.companyId}" does not exist.`);
      if (!(await adapter.findOne({ model: MODELS.company, where: byId(input.companyId) })))
        throw noCompany();
      const existing = await adapter.findOne({
        model,
        where: [
          { field: 'companyId', value: input.companyId },
          { field: 'slug', value: input.slug },
        ],
      });
      if (existing) throw taken();
      const at = now();
      try {
        const row = await adapter.create<Omit<BusinessRow, 'id'>, BusinessRow>({
          model,
          data: {
            companyId: input.companyId,
            slug: input.slug,
            name: input.name,
            logoUrl: input.logoUrl ?? null,
            faviconUrl: input.faviconUrl ?? null,
            status: 'active',
            metadata: { ...(input.metadata ?? {}) },
            version: 1,
            deletedAt: null,
            createdAt: at,
            updatedAt: at,
          },
        });
        return toBusiness(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw taken();
        if (isForeignKeyViolation(error)) throw noCompany();
        throw error;
      }
    },
    async update(id, expectedVersion, changes: BusinessChanges) {
      const set = defined({
        name: changes.name,
        logoUrl: changes.logoUrl,
        faviconUrl: changes.faviconUrl,
        metadata: changes.metadata === undefined ? undefined : { ...changes.metadata },
      });
      return toBusiness(
        await guarded<BusinessRow>(adapter, model, id, expectedVersion, set, now, missing(id)),
      );
    },
    async setStatus(id, expectedVersion, status) {
      return toBusiness(
        await guarded<BusinessRow>(
          adapter,
          model,
          id,
          expectedVersion,
          { status },
          now,
          missing(id),
        ),
      );
    },
    async setDeleted(id, expectedVersion, at) {
      return toBusiness(
        await guarded<BusinessRow>(
          adapter,
          model,
          id,
          expectedVersion,
          { deletedAt: at },
          now,
          missing(id),
        ),
      );
    },
    async listDeletedBefore(before, limit) {
      const rows = await adapter.findMany<BusinessRow>({
        model,
        where: [{ field: 'deletedAt', operator: 'lt', value: before }],
        sortBy: { field: 'id', direction: 'asc' },
        limit,
      });
      return rows.map(toBusiness);
    },
    purge: (ids) =>
      ids.length === 0
        ? Promise.resolve(0)
        : atomic(async (trx) => {
            await dropScopes(trx, 'business', ids);
            await purgeSitesWhere(trx, 'businessId', ids);
            return trx.deleteMany({
              model,
              where: [{ field: 'id', operator: 'in', value: [...ids] }],
            });
          }),
  };
}

// ---------- sedes ----------

/** Condiciones propias de las sedes: el negocio y lo que puede ver quien no ve toda la compañía. */
function siteWhere(filter: SiteFilter): Where[] {
  const where: Where[] = [];
  if (filter.businessId !== undefined)
    where.push({ field: 'businessId', value: filter.businessId });
  const { visible } = filter;
  if (visible === undefined) return where;
  // (sus sedes) OR (las de sus negocios); los adaptadores unen el grupo OR al resto con AND.
  if (visible.siteIds.length > 0) {
    where.push({ field: 'id', operator: 'in', value: [...visible.siteIds], connector: 'OR' });
  }
  if (visible.businessIds.length > 0) {
    where.push({
      field: 'businessId',
      operator: 'in',
      value: [...visible.businessIds],
      connector: 'OR',
    });
  }
  return where;
}

const nothingVisible = (filter: SiteFilter): boolean =>
  filter.ids?.length === 0 ||
  (filter.visible !== undefined &&
    filter.visible.siteIds.length === 0 &&
    filter.visible.businessIds.length === 0);

export function createSiteStore(adapter: Adapter, atomic: Atomic, now: () => Date): SiteStore {
  const model = MODELS.site;
  const missing = (id: string) => () =>
    new AxedaError('AXEDA_SITE_NOT_FOUND', `Site "${id}" does not exist.`);
  const save = (id: string, expectedVersion: number, set: Record<string, unknown>) =>
    guarded<SiteRow>(adapter, model, id, expectedVersion, set, now, missing(id)).then(toSite);

  /** Lo que en SQL harían las claves foráneas; MongoDB no las tiene. */
  async function checkParents(input: NewSite): Promise<void> {
    if (!(await adapter.findOne({ model: MODELS.company, where: byId(input.companyId) }))) {
      throw new AxedaError(
        'AXEDA_COMPANY_NOT_FOUND',
        `Company "${input.companyId}" does not exist.`,
      );
    }
    const businessId = input.businessId ?? null;
    if (businessId === null) return;
    const business = await adapter.findOne<{ companyId: string }>({
      model: MODELS.business,
      where: byId(businessId),
    });
    if (business?.companyId !== input.companyId) {
      throw new AxedaError('AXEDA_BUSINESS_NOT_FOUND', `Business "${businessId}" does not exist.`);
    }
  }

  return {
    async get(id) {
      const row = await adapter.findOne<SiteRow>({ model, where: byId(id) });
      return row ? toSite(row) : null;
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      const rows = await adapter.findMany<SiteRow>({
        model,
        where: [{ field: 'id', operator: 'in', value: [...ids] }],
        limit: ids.length,
      });
      return rows.map(toSite);
    },
    async getBySlug(companyId, slug) {
      const row = await adapter.findOne<SiteRow>({
        model,
        where: [
          { field: 'companyId', value: companyId },
          { field: 'slug', value: slug },
        ],
      });
      return row ? toSite(row) : null;
    },
    async listForCompany(companyId, filter, page) {
      if (nothingVisible(filter)) return emptyPage();
      return pageOf<SiteRow, Site>(
        adapter,
        model,
        [{ field: 'companyId', value: companyId }, ...filterWhere(filter), ...siteWhere(filter)],
        'slug',
        (row) => row.slug,
        page,
        toSite,
      );
    },
    async create(input: NewSite) {
      const taken = () =>
        new AxedaError(
          'AXEDA_SLUG_TAKEN',
          `A site with slug "${input.slug}" already exists in that company.`,
        );
      await checkParents(input);
      const existing = await adapter.findOne({
        model,
        where: [
          { field: 'companyId', value: input.companyId },
          { field: 'slug', value: input.slug },
        ],
      });
      if (existing) throw taken();
      const at = now();
      try {
        const row = await adapter.create<Omit<SiteRow, 'id'>, SiteRow>({
          model,
          data: {
            companyId: input.companyId,
            businessId: input.businessId ?? null,
            slug: input.slug,
            name: input.name,
            logoUrl: input.logoUrl ?? null,
            faviconUrl: input.faviconUrl ?? null,
            status: 'active',
            metadata: { ...(input.metadata ?? {}) },
            version: 1,
            deletedAt: null,
            createdAt: at,
            updatedAt: at,
          },
        });
        return toSite(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw taken();
        // La compañía o el negocio desaparecieron entre la comprobación y la inserción.
        if (isForeignKeyViolation(error)) {
          throw new AxedaError(
            'AXEDA_COMPANY_NOT_FOUND',
            `Company "${input.companyId}" does not exist.`,
          );
        }
        throw error;
      }
    },
    update: (id, expectedVersion, changes: SiteChanges) =>
      save(
        id,
        expectedVersion,
        defined({
          name: changes.name,
          logoUrl: changes.logoUrl,
          faviconUrl: changes.faviconUrl,
          metadata: changes.metadata === undefined ? undefined : { ...changes.metadata },
        }),
      ),
    setStatus: (id, expectedVersion, status) => save(id, expectedVersion, { status }),
    setDeleted: (id, expectedVersion, at) => save(id, expectedVersion, { deletedAt: at }),
    async listDeletedBefore(before, limit) {
      const rows = await adapter.findMany<SiteRow>({
        model,
        where: [{ field: 'deletedAt', operator: 'lt', value: before }],
        sortBy: { field: 'id', direction: 'asc' },
        limit,
      });
      return rows.map(toSite);
    },
    purge: (ids) =>
      ids.length === 0 ? Promise.resolve(0) : atomic((trx) => purgeSitesWhere(trx, 'id', ids)),
  };
}

// ---------- invitaciones ----------

/** Texto estable de «correo + alcance»; se reduce a un hash corto para la clave única. */
async function pendingKey(email: string, scope: AssignmentScope): Promise<string> {
  const data = new TextEncoder().encode(`${email}|${scopeKey(scope)}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return `pending:${Buffer.from(digest).toString('hex')}`;
}

export function createInvitationStore(adapter: Adapter, now: () => Date): InvitationStore {
  const model = MODELS.invitation;

  return {
    async get(id) {
      const row = await adapter.findOne<InvitationRow>({ model, where: byId(id) });
      return row ? toInvitation(row) : null;
    },
    async findPending(email, scope) {
      const row = await adapter.findOne<InvitationRow>({
        model,
        where: [{ field: 'pendingKey', value: await pendingKey(email, scope) }],
      });
      return row ? toInvitation(row) : null;
    },
    async create(input: NewInvitation) {
      const exists = () =>
        new AxedaError(
          'AXEDA_INVITATION_EXISTS',
          'There is already a pending invitation for that email and scope.',
        );
      const key = await pendingKey(input.email, input.scope);
      if (await adapter.findOne({ model, where: [{ field: 'pendingKey', value: key }] }))
        throw exists();
      try {
        const row = await adapter.create<
          Omit<InvitationRow, 'id'> & { pendingKey: string; consumed: number },
          InvitationRow
        >({
          model,
          data: {
            email: input.email,
            ...scopeColumns(input.scope),
            roleIds: [...input.roleIds],
            invitedBy: input.invitedBy,
            secretHash: input.secretHash,
            expiresAt: input.expiresAt,
            acceptedAt: null,
            revokedAt: null,
            pendingKey: key,
            consumed: 0,
            createdAt: now(),
          },
        });
        return toInvitation(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw exists();
        throw error;
      }
    },
    async close(id, outcome, at) {
      // Solo una llamada consigue pasar `consumed` de 0 a 1; el resto recibe `null`.
      const closed = await adapter.incrementOne<InvitationRow>({
        model,
        where: [
          { field: 'id', value: id },
          { field: 'consumed', value: 0 },
        ],
        increment: { consumed: 1 },
        set: {
          [outcome === 'accepted' ? 'acceptedAt' : 'revokedAt']: at,
          pendingKey: `closed:${id}`,
        },
      });
      return closed !== null;
    },
    async list(scope, options, page) {
      const columns = scopeColumns(scope);
      const where: Where[] = [
        { field: 'scopeType', value: columns.scopeType },
        { field: 'scopeId', value: columns.scopeId },
        ...(options.pendingOnly
          ? [
              { field: 'consumed', value: 0 },
              { field: 'expiresAt', operator: 'gt' as const, value: options.now },
            ]
          : []),
      ];
      const result = await pageOf<InvitationRow, StoredInvitation>(
        adapter,
        model,
        where,
        'id',
        (row) => row.id,
        page,
        toInvitation,
      );
      return {
        items: result.items.map(withoutSecret),
        nextCursor: result.nextCursor,
      };
    },
  };
}
