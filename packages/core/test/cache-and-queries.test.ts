import { describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_SCOPE,
  isAxedaError,
  type AssignmentScope,
  type AxedaErrorCode,
} from '../src/index.js';
import { AuthzCache } from '../src/application/authz-cache.js';
import { createFixture } from './fixture.js';

const rejectsWith = async (promise: Promise<unknown>, code: AxedaErrorCode) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isAxedaError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
};

const empty = { assignments: [], roles: new Map(), unusable: new Set<string>() };

describe('AuthzCache', () => {
  it('serves an entry only while both versions match', () => {
    const cache = new AuthzCache(10);
    cache.set('u', 1, 1, empty);
    expect(cache.get('u', 1, 1)).toBe(empty);
    expect(cache.get('u', 2, 1)).toBeUndefined();
    cache.set('u', 1, 1, empty);
    expect(cache.get('u', 1, 2)).toBeUndefined();
    // Una entrada vieja se descarta: no puede "resucitar" si la versión vuelve a coincidir.
    expect(cache.get('u', 1, 1)).toBeUndefined();
  });

  it('keeps users apart', () => {
    const cache = new AuthzCache(10);
    cache.set('a', 1, 1, empty);
    expect(cache.get('b', 1, 1)).toBeUndefined();
  });

  it('is bounded and evicts the least recently used user', () => {
    const cache = new AuthzCache(2);
    cache.set('a', 1, 1, empty);
    cache.set('b', 1, 1, empty);
    expect(cache.get('a', 1, 1)).toBe(empty); // a pasa a ser la más reciente
    cache.set('c', 1, 1, empty);
    expect(cache.size).toBe(2);
    expect(cache.get('b', 1, 1)).toBeUndefined();
    expect(cache.get('a', 1, 1)).toBe(empty);
    expect(cache.get('c', 1, 1)).toBe(empty);
  });
});

async function cachedScenario() {
  const f = await createFixture();
  const role = await f.role('reader', ['invoice:read']);
  f.user('alice');
  await f.give('alice', 'reader');
  const realLoad = f.persistence.assignments.listForUser.bind(f.persistence.assignments);
  const load = vi.spyOn(f.persistence.assignments, 'listForUser');
  load.mockClear();
  return { ...f, role, load, realLoad };
}

describe('the version-validated cache', () => {
  it('loads once while nothing changes', async () => {
    const f = await cachedScenario();
    const alice = { userId: 'alice' };
    for (let index = 0; index < 5; index += 1) {
      expect(await f.axeda.can(alice, 'invoice:read')).toBe(true);
    }
    expect(f.load).toHaveBeenCalledTimes(1);
  });

  it('answers different scopes from one load', async () => {
    const f = await cachedScenario();
    const alice = { userId: 'alice' };
    await f.axeda.can(alice, 'invoice:read', { type: 'company', companyId: 'A' });
    await f.axeda.can(alice, 'invoice:read', { type: 'company', companyId: 'B' });
    await f.axeda.scopesFor(alice, 'invoice:read');
    expect(f.load).toHaveBeenCalledTimes(1);
  });

  it('reloads after a change to that user (authzVersion)', async () => {
    const f = await cachedScenario();
    const alice = { userId: 'alice' };
    await f.axeda.can(alice, 'invoice:read');
    await f.persistence.authz.bumpUserVersion('alice');
    await f.axeda.can(alice, 'invoice:read');
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('reloads for everyone after a role change (policyVersion)', async () => {
    const f = await cachedScenario();
    f.user('carol');
    await f.give('carol', 'reader');
    f.load.mockClear();
    await f.axeda.can({ userId: 'alice' }, 'invoice:read');
    await f.axeda.can({ userId: 'carol' }, 'invoice:read');
    expect(f.load).toHaveBeenCalledTimes(2);

    await f.axeda.roles.update(f.admin, f.role.id, f.role.version, { name: 'renamed' });
    await f.axeda.can({ userId: 'alice' }, 'invoice:read');
    await f.axeda.can({ userId: 'carol' }, 'invoice:read');
    expect(f.load).toHaveBeenCalledTimes(4);
  });

  it('never leaks one user’s permissions to another', async () => {
    const f = await cachedScenario();
    f.user('mallory');
    await f.axeda.can({ userId: 'alice' }, 'invoice:read');
    expect(await f.axeda.can({ userId: 'mallory' }, 'invoice:read')).toBe(false);
  });

  it('does not ask for the user version when the principal already carries it', async () => {
    const f = await cachedScenario();
    const userVersion = vi.spyOn(f.persistence.authz, 'getUserVersion');
    await f.axeda.can({ userId: 'alice', authzVersion: 7 }, 'invoice:read');
    expect(userVersion).not.toHaveBeenCalled();
    await f.axeda.can({ userId: 'alice' }, 'invoice:read');
    expect(userVersion).toHaveBeenCalledTimes(1);
  });

  it('reads the versions BEFORE the data, so a change in between can never be hidden', async () => {
    const f = await cachedScenario();
    const assignment = (await f.persistence.assignments.listForUser('alice'))[0];
    let revoked = false;
    f.load.mockImplementation(async (userId) => {
      const data = await f.realLoad(userId);
      if (!revoked) {
        revoked = true;
        // El administrador revoca justo después de que se leyeron los datos.
        await f.axeda.assignments.revoke(f.admin, assignment?.id ?? '');
      }
      return data;
    });

    const alice = { userId: 'alice' };
    // Esta petición ya estaba en vuelo al revocar: puede ver los datos viejos.
    await f.axeda.can(alice, 'invoice:read');
    // Pero la SIGUIENTE ya no: si las versiones se hubieran leído después de los datos, los datos
    // viejos quedarían etiquetados con la versión nueva y se servirían para siempre.
    expect(await f.axeda.can(alice, 'invoice:read')).toBe(false);
    expect(await f.axeda.can(alice, 'invoice:read')).toBe(false);
  });

  it('the cache bound comes from the options', async () => {
    const f = await createFixture({ permissions: ['a:b'], limits: { maxCachedUsers: 1 } });
    const role = await f.role('r', ['a:b']);
    f.user('u1');
    f.user('u2');
    await f.give('u1', 'r');
    await f.give('u2', 'r');
    const load = vi.spyOn(f.persistence.assignments, 'listForUser');
    load.mockClear();
    await f.axeda.can({ userId: 'u1' }, 'a:b');
    await f.axeda.can({ userId: 'u2' }, 'a:b');
    await f.axeda.can({ userId: 'u1' }, 'a:b'); // u1 fue expulsada por u2
    expect(load).toHaveBeenCalledTimes(3);
    void role;
  });
});

describe('scopesFor and scopeFilter', () => {
  async function multi() {
    const f = await createFixture();
    for (const id of ['A', 'B', 'C']) await f.company(id);
    await f.business('b1', 'A');
    await f.business('b9', 'A');
    await f.role('reader', ['invoice:read']);
    await f.role('writer', ['invoice:create']);
    f.user('alice');
    return f;
  }
  const companyA: AssignmentScope = { type: 'company', id: 'A' };

  it('lists the scopes where the permission is granted', async () => {
    const f = await multi();
    await f.give('alice', 'reader', companyA);
    await f.give('alice', 'reader', { type: 'business', id: 'b9' });
    await f.give('alice', 'writer', { type: 'company', id: 'C' });
    const scopes = await f.axeda.scopesFor({ userId: 'alice' }, 'invoice:read');
    expect(scopes).toEqual(expect.arrayContaining([companyA, { type: 'business', id: 'b9' }]));
    expect(scopes).toHaveLength(2);
  });

  it('turns it into a filter for the application’s queries', async () => {
    const f = await multi();
    await f.give('alice', 'reader', companyA);
    await f.give('alice', 'reader', { type: 'company', id: 'B' });
    await f.give('alice', 'reader', { type: 'business', id: 'b9' });
    expect(await f.axeda.scopeFilter({ userId: 'alice' }, 'invoice:read')).toEqual({
      unrestricted: false,
      companyIds: ['A', 'B'],
      businessIds: ['b9'],
    });
    expect(await f.axeda.scopeFilter({ userId: 'alice' }, 'invoice:create')).toEqual({
      unrestricted: false,
      companyIds: [],
      businessIds: [],
    });
  });

  it('is unrestricted for a global grant, and honours wildcards', async () => {
    const f = await multi();
    expect((await f.axeda.scopeFilter(f.admin, 'invoice:read')).unrestricted).toBe(true);
    await f.role('invoice-all', ['invoice:*']);
    await f.give('alice', 'invoice-all', companyA);
    expect((await f.axeda.scopeFilter({ userId: 'alice' }, 'invoice:delete')).companyIds).toEqual([
      'A',
    ]);
  });

  it('ignores expired assignments and roles that require MFA without it', async () => {
    const f = await multi();
    await f.role('strict', ['report:read'], { requireMfa: true });
    f.user('bob', { twoFactorEnabled: true });
    await f.give('bob', 'strict', companyA);
    expect(await f.axeda.scopesFor({ userId: 'bob' }, 'report:read')).toEqual([]);
    expect(
      await f.axeda.scopesFor({ userId: 'bob', twoFactorEnabled: true }, 'report:read'),
    ).toEqual([companyA]);

    const roleId = (await f.persistence.roles.getByKey('reader'))?.id ?? '';
    await f.axeda.assignments.assign(f.admin, {
      userId: 'alice',
      roleId,
      scope: companyA,
      expiresAt: new Date(f.clock.current.getTime() + 1000),
    });
    expect(await f.axeda.scopesFor({ userId: 'alice' }, 'invoice:read')).toEqual([companyA]);
    f.clock.current = new Date(f.clock.current.getTime() + 1000);
    expect(await f.axeda.scopesFor({ userId: 'alice' }, 'invoice:read')).toEqual([]);
  });

  it('treats a mistyped or wildcard permission as an error, not as an empty answer', async () => {
    const f = await multi();
    await rejectsWith(
      f.axeda.scopesFor({ userId: 'alice' }, 'invoice:raed'),
      'AXEDA_UNKNOWN_PERMISSION',
    );
    await rejectsWith(
      f.axeda.scopeFilter({ userId: 'alice' }, 'invoice:*'),
      'AXEDA_INVALID_PERMISSION',
    );
    await rejectsWith(
      f.axeda.canAnywhere({ userId: 'alice' }, 'nope:nope'),
      'AXEDA_UNKNOWN_PERMISSION',
    );
  });

  it('canAnywhere tells whether the permission is held in any scope', async () => {
    const f = await multi();
    await f.give('alice', 'reader', { type: 'business', id: 'b1' });
    expect(await f.axeda.canAnywhere({ userId: 'alice' }, 'invoice:read')).toBe(true);
    expect(await f.axeda.canAnywhere({ userId: 'alice' }, 'invoice:create')).toBe(false);
    expect(await f.axeda.can({ userId: 'alice' }, 'invoice:read')).toBe(false);
  });
});

describe('the audit log', () => {
  it('is readable globally only with a global audit:read, and per company with a company grant', async () => {
    const f = await createFixture();
    await f.company('A');
    await f.role('auditor', ['axeda:audit:read']);
    f.user('carol');
    f.user('dave');
    await f.give('carol', 'auditor', { type: 'company', id: 'A' });
    await f.give('dave', 'auditor', GLOBAL_SCOPE);
    const carol = { userId: 'carol' };

    await rejectsWith(f.axeda.listAudit(carol, {}, { limit: 5 }), 'AXEDA_FORBIDDEN');
    await rejectsWith(
      f.axeda.listAudit(carol, { scope: { type: 'company', id: 'B' } }, { limit: 5 }),
      'AXEDA_FORBIDDEN',
    );
    await f.axeda.listAudit(carol, { scope: { type: 'company', id: 'A' } }, { limit: 5 });
    const all = await f.axeda.listAudit({ userId: 'dave' }, {}, { limit: 100 });
    expect(all.items.length).toBeGreaterThan(0);
    await rejectsWith(f.axeda.listAudit({ userId: 'nobody' }, {}, { limit: 5 }), 'AXEDA_FORBIDDEN');
  });

  it('bounds oversized metadata and clips the request details', async () => {
    const f = await createFixture();
    const huge = 'x'.repeat(5000);
    await f.axeda.roles.create(
      { ...f.admin, ip: '1'.repeat(200), userAgent: huge },
      { key: 'big', name: 'Big', permissions: ['invoice:read'], description: huge.slice(0, 900) },
    );
    const [event] = (await f.axeda.listAudit(f.admin, { action: 'role.create' }, { limit: 1 }))
      .items;
    expect(event?.ip).toHaveLength(64);
    expect(event?.userAgent).toHaveLength(255);
  });

  it('returns the newest events first', async () => {
    const f = await createFixture();
    await f.role('one', ['invoice:read']);
    await f.role('two', ['invoice:read']);
    const { items } = await f.axeda.listAudit(f.admin, { action: 'role.create' }, { limit: 10 });
    expect(items.map((event) => event.metadata['key'])).toEqual(['two', 'one']);
  });
});
