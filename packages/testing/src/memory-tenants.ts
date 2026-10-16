import {
  AxedaError,
  businessKey,
  companyKey,
  scopeKey,
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
  type RoleAssignment,
  type StoredInvitation,
  type TenantFilter,
  withoutSecret,
} from '@axeda/core';

/** El estado que comparten los almacenes en memoria. */
export interface TenantState {
  companies: Map<string, Company>;
  businesses: Map<string, Business>;
  invitations: Map<string, StoredInvitation>;
  assignments: Map<string, RoleAssignment>;
}

/** Ejecuta `fn` con exclusión: las operaciones y transacciones se serializan. */
export type Run = <T>(fn: () => Promise<T>) => Promise<T>;

interface Context {
  readonly state: TenantState;
  readonly run: Run;
  readonly now: () => Date;
  readonly nextId: () => string;
}

export const encodeCursor = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');
export const decodeCursor = (cursor: string): string =>
  Buffer.from(cursor, 'base64url').toString('utf8');

/** Pagina una lista ya ordenada por `key` con un cursor opaco. */
export function paginate<T>(
  sorted: readonly T[],
  key: (item: T) => string,
  page: PageRequest,
): Page<T> {
  const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
  const remaining = after === null ? sorted : sorted.filter((item) => key(item) > after);
  const items = remaining.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: remaining.length > items.length && last ? encodeCursor(key(last)) : null,
  };
}

const matches = (entity: { id: string; deletedAt: Date | null }, filter: TenantFilter): boolean => {
  if (filter.ids !== undefined && !filter.ids.includes(entity.id)) return false;
  const deleted = filter.deleted ?? 'exclude';
  if (deleted === 'exclude') return entity.deletedAt === null;
  if (deleted === 'only') return entity.deletedAt !== null;
  return true;
};

const conflict = (kind: string, id: string, found: number, expected: number): AxedaError =>
  new AxedaError(
    'AXEDA_VERSION_CONFLICT',
    `${kind} "${id}" is at version ${found}, not ${expected}.`,
  );

/** Quita asignaciones e invitaciones de los alcances indicados (claves de `scopeKey`). */
function dropScopes(state: TenantState, keys: ReadonlySet<string>): void {
  for (const [id, assignment] of state.assignments) {
    if (keys.has(scopeKey(assignment.scope))) state.assignments.delete(id);
  }
  for (const [id, invitation] of state.invitations) {
    if (keys.has(scopeKey(invitation.scope))) state.invitations.delete(id);
  }
}

export function createCompanyStore(context: Context): CompanyStore {
  const { state, run, now, nextId } = context;
  const need = (id: string, expectedVersion: number): Company => {
    const current = state.companies.get(id);
    if (!current)
      throw new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${id}" does not exist.`);
    if (current.version !== expectedVersion)
      throw conflict('Company', id, current.version, expectedVersion);
    return current;
  };
  const save = (company: Company, patch: Partial<Company>): Company => {
    const next: Company = { ...company, ...patch, version: company.version + 1, updatedAt: now() };
    state.companies.set(company.id, next);
    return next;
  };

  return {
    get: (id) => run(async () => state.companies.get(id) ?? null),
    getMany: (ids) => run(async () => ids.flatMap((id) => state.companies.get(id) ?? [])),
    getBySlug: (slug) =>
      run(
        async () => [...state.companies.values()].find((company) => company.slug === slug) ?? null,
      ),
    list: (filter, page) =>
      run(async () => {
        const sorted = [...state.companies.values()]
          .filter((company) => matches(company, filter))
          .sort((a, b) => a.slug.localeCompare(b.slug));
        return paginate(sorted, (company) => company.slug, page);
      }),
    create: (input: NewCompany) =>
      run(async () => {
        if ([...state.companies.values()].some((company) => company.slug === input.slug)) {
          throw new AxedaError(
            'AXEDA_SLUG_TAKEN',
            `A company with slug "${input.slug}" already exists.`,
          );
        }
        const at = now();
        const company: Company = {
          id: nextId(),
          slug: input.slug,
          name: input.name,
          legalName: input.legalName ?? null,
          logoUrl: input.logoUrl ?? null,
          faviconUrl: input.faviconUrl ?? null,
          status: 'active',
          metadata: input.metadata ?? {},
          version: 1,
          deletedAt: null,
          createdAt: at,
          updatedAt: at,
        };
        state.companies.set(company.id, company);
        return company;
      }),
    update: (id, expectedVersion, changes: CompanyChanges) =>
      run(async () => {
        const current = need(id, expectedVersion);
        return save(current, {
          name: changes.name ?? current.name,
          legalName: changes.legalName === undefined ? current.legalName : changes.legalName,
          logoUrl: changes.logoUrl === undefined ? current.logoUrl : changes.logoUrl,
          faviconUrl: changes.faviconUrl === undefined ? current.faviconUrl : changes.faviconUrl,
          metadata: changes.metadata ?? current.metadata,
        });
      }),
    setStatus: (id, expectedVersion, status) =>
      run(async () => save(need(id, expectedVersion), { status })),
    setDeleted: (id, expectedVersion, at) =>
      run(async () => save(need(id, expectedVersion), { deletedAt: at })),
    listDeletedBefore: (before, limit) =>
      run(async () =>
        [...state.companies.values()]
          .filter((company) => company.deletedAt !== null && company.deletedAt < before)
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .slice(0, limit),
      ),
    purge: (ids) =>
      run(async () => {
        const doomed = new Set(ids.filter((id) => state.companies.has(id)));
        const keys = new Set<string>([...doomed].map(companyKey));
        for (const [businessId, business] of state.businesses) {
          if (doomed.has(business.companyId)) {
            keys.add(businessKey(businessId));
            state.businesses.delete(businessId);
          }
        }
        for (const id of doomed) state.companies.delete(id);
        dropScopes(state, keys);
        return doomed.size;
      }),
  };
}

export function createBusinessStore(context: Context): BusinessStore {
  const { state, run, now, nextId } = context;
  const need = (id: string, expectedVersion: number): Business => {
    const current = state.businesses.get(id);
    if (!current)
      throw new AxedaError('AXEDA_BUSINESS_NOT_FOUND', `Business "${id}" does not exist.`);
    if (current.version !== expectedVersion)
      throw conflict('Business', id, current.version, expectedVersion);
    return current;
  };
  const save = (business: Business, patch: Partial<Business>): Business => {
    const next: Business = {
      ...business,
      ...patch,
      version: business.version + 1,
      updatedAt: now(),
    };
    state.businesses.set(business.id, next);
    return next;
  };

  return {
    get: (id) => run(async () => state.businesses.get(id) ?? null),
    getMany: (ids) => run(async () => ids.flatMap((id) => state.businesses.get(id) ?? [])),
    getBySlug: (companyId, slug) =>
      run(
        async () =>
          [...state.businesses.values()].find(
            (business) => business.companyId === companyId && business.slug === slug,
          ) ?? null,
      ),
    listForCompany: (companyId, filter, page) =>
      run(async () => {
        const sorted = [...state.businesses.values()]
          .filter((business) => business.companyId === companyId && matches(business, filter))
          .sort((a, b) => a.slug.localeCompare(b.slug));
        return paginate(sorted, (business) => business.slug, page);
      }),
    create: (input: NewBusiness) =>
      run(async () => {
        if (!state.companies.has(input.companyId)) {
          throw new AxedaError(
            'AXEDA_COMPANY_NOT_FOUND',
            `Company "${input.companyId}" does not exist.`,
          );
        }
        const taken = [...state.businesses.values()].some(
          (business) => business.companyId === input.companyId && business.slug === input.slug,
        );
        if (taken) {
          throw new AxedaError(
            'AXEDA_SLUG_TAKEN',
            `A business with slug "${input.slug}" already exists in that company.`,
          );
        }
        const at = now();
        const business: Business = {
          id: nextId(),
          companyId: input.companyId,
          slug: input.slug,
          name: input.name,
          logoUrl: input.logoUrl ?? null,
          faviconUrl: input.faviconUrl ?? null,
          status: 'active',
          metadata: input.metadata ?? {},
          version: 1,
          deletedAt: null,
          createdAt: at,
          updatedAt: at,
        };
        state.businesses.set(business.id, business);
        return business;
      }),
    update: (id, expectedVersion, changes: BusinessChanges) =>
      run(async () => {
        const current = need(id, expectedVersion);
        return save(current, {
          name: changes.name ?? current.name,
          logoUrl: changes.logoUrl === undefined ? current.logoUrl : changes.logoUrl,
          faviconUrl: changes.faviconUrl === undefined ? current.faviconUrl : changes.faviconUrl,
          metadata: changes.metadata ?? current.metadata,
        });
      }),
    setStatus: (id, expectedVersion, status) =>
      run(async () => save(need(id, expectedVersion), { status })),
    setDeleted: (id, expectedVersion, at) =>
      run(async () => save(need(id, expectedVersion), { deletedAt: at })),
    listDeletedBefore: (before, limit) =>
      run(async () =>
        [...state.businesses.values()]
          .filter((business) => business.deletedAt !== null && business.deletedAt < before)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit),
      ),
    purge: (ids) =>
      run(async () => {
        const doomed = ids.filter((id) => state.businesses.has(id));
        for (const id of doomed) state.businesses.delete(id);
        dropScopes(state, new Set(doomed.map(businessKey)));
        return doomed.length;
      }),
  };
}

const isPending = (invitation: StoredInvitation): boolean =>
  invitation.acceptedAt === null && invitation.revokedAt === null;

export function createInvitationStore(context: Context): InvitationStore {
  const { state, run, nextId, now } = context;

  return {
    get: (id) => run(async () => state.invitations.get(id) ?? null),
    findPending: (email, scope) =>
      run(
        async () =>
          [...state.invitations.values()].find(
            (invitation) =>
              isPending(invitation) &&
              invitation.email === email &&
              scopeKey(invitation.scope) === scopeKey(scope),
          ) ?? null,
      ),
    create: (input: NewInvitation) =>
      run(async () => {
        const exists = [...state.invitations.values()].some(
          (invitation) =>
            isPending(invitation) &&
            invitation.email === input.email &&
            scopeKey(invitation.scope) === scopeKey(input.scope),
        );
        if (exists) {
          throw new AxedaError(
            'AXEDA_INVITATION_EXISTS',
            'There is already a pending invitation for that email and scope.',
          );
        }
        const invitation: StoredInvitation = {
          id: nextId(),
          email: input.email,
          scope: input.scope,
          roleIds: [...input.roleIds],
          invitedBy: input.invitedBy,
          expiresAt: input.expiresAt,
          secretHash: input.secretHash,
          createdAt: now(),
          acceptedAt: null,
          revokedAt: null,
        };
        state.invitations.set(invitation.id, invitation);
        return invitation;
      }),
    close: (id, outcome, at) =>
      run(async () => {
        const current = state.invitations.get(id);
        if (!current || !isPending(current)) return false;
        state.invitations.set(id, {
          ...current,
          ...(outcome === 'accepted' ? { acceptedAt: at } : { revokedAt: at }),
        });
        return true;
      }),
    list: (scope, options, page) =>
      run(async () => {
        const sorted = [...state.invitations.values()]
          .filter((invitation) => scopeKey(invitation.scope) === scopeKey(scope))
          .filter(
            (invitation) =>
              !options.pendingOnly || (isPending(invitation) && invitation.expiresAt > options.now),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        const { items, nextCursor } = paginate(sorted, (invitation) => invitation.id, page);
        return {
          items: items.map(withoutSecret),
          nextCursor,
        };
      }),
  };
}
