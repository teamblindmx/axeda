import { describe, expect, it } from 'vitest';
import { isAxedaError, type Actor, type AssignmentScope } from '../src/index.js';
import { createFixture, type Fixture } from './fixture.js';

/**
 * Quien no puede hacer algo no debe poder averiguar, por la respuesta, qué compañías, negocios,
 * asignaciones o invitaciones existen (T10). Cada operación se llama con un identificador REAL
 * y con uno inventado, y las dos respuestas deben ser idénticas (mismo código y mismo mensaje
 * una vez quitado el identificador).
 */

interface Things {
  readonly company: string;
  readonly business: string;
  readonly assignment: string;
  readonly invitation: string;
}

async function world() {
  const f = await createFixture();
  const cashier = await f.role('cashier', ['invoice:read']);
  // Quien administra una compañía: todos los permisos propios de Axeda que valen a ese nivel.
  await f.role('company-admin', [
    'axeda:assignment:manage',
    'axeda:invitation:manage',
    'axeda:company:manage',
    'axeda:business:manage',
    'axeda:audit:read',
  ]);
  for (const user of ['ana', 'bob', 'eve', 'carl', 'dora']) f.user(user);

  const make = async (slug: string, member: string): Promise<Things> => {
    const company = await f.company(slug);
    const business = await f.business(`${slug}-shop`, company.id);
    await f.give(member, 'cashier', { type: 'company', id: company.id });
    const [assignment] = await f.axeda.assignments.listForUser(f.admin, member);
    const invitation = await f.axeda.invitations.create(f.admin, {
      email: `${slug}@test.dev`,
      scope: { type: 'company', id: company.id },
      roleIds: [cashier.id],
    });
    return {
      company: company.id,
      business: business.id,
      assignment: assignment?.id ?? '',
      invitation: invitation.id,
    };
  };
  const acme = await make('acme', 'ana');
  const globex = await make('globex', 'bob');
  // carl administra Acme; dora administra Globex.
  await f.give('carl', 'company-admin', { type: 'company', id: acme.company });
  await f.give('dora', 'company-admin', { type: 'company', id: globex.company });
  return { f, cashier, acme, globex };
}

/** Lo que una persona ve de una llamada: el código y el mensaje sin los identificadores. */
async function seen(call: () => Promise<unknown>, ids: string[]): Promise<string> {
  try {
    await call();
    return 'allowed';
  } catch (error) {
    if (!isAxedaError(error)) return `unexpected: ${String(error)}`;
    // De los identificadores más largos a los más cortos: «acme-shop» antes que «acme».
    const longestFirst = [...ids].sort((a, b) => b.length - a.length);
    const message = longestFirst.reduce((text, id) => text.split(id).join('<id>'), error.message);
    return `${error.code}: ${message}`;
  }
}

const FAKE = 'does-not-exist';
const company = (id: string): AssignmentScope => ({ type: 'company', id });
const business = (id: string): AssignmentScope => ({ type: 'business', id });
const page = { limit: 10 };

/** Cada operación que recibe un identificador, con el identificador real que le corresponde. */
function probes(f: Fixture, actor: Actor, cashierId: string, t: Things) {
  const ops: Array<[string, string, (id: string) => Promise<unknown>]> = [
    ['companies.get', t.company, (id) => f.axeda.companies.get(actor, id)],
    ['companies.update', t.company, (id) => f.axeda.companies.update(actor, id, 1, { name: 'x' })],
    [
      'companies.setStatus',
      t.company,
      (id) => f.axeda.companies.setStatus(actor, id, 1, 'inactive'),
    ],
    ['companies.delete', t.company, (id) => f.axeda.companies.delete(actor, id, 1)],
    ['companies.restore', t.company, (id) => f.axeda.companies.restore(actor, id, 1)],
    ['businesses.get', t.business, (id) => f.axeda.businesses.get(actor, id)],
    ['businesses.list', t.company, (id) => f.axeda.businesses.list(actor, id, {}, page)],
    [
      'businesses.create',
      t.company,
      (id) => f.axeda.businesses.create(actor, id, { slug: 'zz', name: 'Z' }),
    ],
    [
      'businesses.update',
      t.business,
      (id) => f.axeda.businesses.update(actor, id, 1, { name: 'x' }),
    ],
    [
      'businesses.setStatus',
      t.business,
      (id) => f.axeda.businesses.setStatus(actor, id, 1, 'inactive'),
    ],
    ['businesses.delete', t.business, (id) => f.axeda.businesses.delete(actor, id, 1)],
    ['businesses.restore', t.business, (id) => f.axeda.businesses.restore(actor, id, 1)],
    [
      'assignments.listForScope (company)',
      t.company,
      (id) => f.axeda.assignments.listForScope(actor, company(id), page),
    ],
    [
      'assignments.listForScope (business)',
      t.business,
      (id) => f.axeda.assignments.listForScope(actor, business(id), page),
    ],
    [
      'assignments.assign (company)',
      t.company,
      (id) =>
        f.axeda.assignments.assign(actor, { userId: 'eve', roleId: cashierId, scope: company(id) }),
    ],
    [
      'assignments.assign (business)',
      t.business,
      (id) =>
        f.axeda.assignments.assign(actor, {
          userId: 'eve',
          roleId: cashierId,
          scope: business(id),
        }),
    ],
    ['assignments.revoke', t.assignment, (id) => f.axeda.assignments.revoke(actor, id)],
    [
      'invitations.create (company)',
      t.company,
      (id) =>
        f.axeda.invitations.create(actor, {
          email: 'x@test.dev',
          scope: company(id),
          roleIds: [cashierId],
        }),
    ],
    [
      'invitations.create (business)',
      t.business,
      (id) =>
        f.axeda.invitations.create(actor, {
          email: 'x@test.dev',
          scope: business(id),
          roleIds: [cashierId],
        }),
    ],
    [
      'invitations.list (company)',
      t.company,
      (id) => f.axeda.invitations.list(actor, company(id), {}, page),
    ],
    [
      'invitations.list (business)',
      t.business,
      (id) => f.axeda.invitations.list(actor, business(id), {}, page),
    ],
    ['invitations.revoke', t.invitation, (id) => f.axeda.invitations.revoke(actor, id)],
    [
      'listAudit (company)',
      t.company,
      (id) => f.axeda.listAudit(actor, { scope: company(id) }, page),
    ],
    [
      'listAudit (business)',
      t.business,
      (id) => f.axeda.listAudit(actor, { scope: business(id) }, page),
    ],
    ['roles.get', cashierId, (id) => f.axeda.roles.get(actor, id)],
  ];
  return ops;
}

/**
 * `withRoles`: las funciones son globales y compartidas, no de una compañía; quien puede
 * administrar asignaciones tiene derecho a leerlas, así que para un administrador «existe» frente
 * a «no existe» NO es una fuga entre compañías y se deja fuera de su comparación.
 */
async function leaks(
  f: Fixture,
  actor: Actor,
  cashierId: string,
  target: Things,
  others: Things,
  withRoles: boolean,
) {
  const ids = [...Object.values(target), ...Object.values(others), cashierId, FAKE];
  const found: string[] = [];
  for (const [name, realId, call] of probes(f, actor, cashierId, target)) {
    if (!withRoles && name === 'roles.get') continue;
    const withReal = await seen(() => call(realId), ids);
    const withFake = await seen(() => call(FAKE), ids);
    if (withReal !== withFake) found.push(`${name}\n    real: ${withReal}\n    fake: ${withFake}`);
  }
  return found;
}

describe('quien no puede hacer algo no averigua qué existe', () => {
  it('a person with no roles, asking about Acme', async () => {
    const { f, cashier, acme, globex } = await world();
    const found = await leaks(f, f.user('eve'), cashier.id, acme, globex, true);
    expect(found, `\n${found.join('\n')}`).toEqual([]);
  });

  it('a member of Globex, asking about Acme', async () => {
    const { f, cashier, acme, globex } = await world();
    const found = await leaks(f, f.user('bob'), cashier.id, acme, globex, true);
    expect(found, `\n${found.join('\n')}`).toEqual([]);
  });

  it('the administrator of Acme, asking about everything in Globex', async () => {
    const { f, cashier, acme, globex } = await world();
    const found = await leaks(f, f.user('carl'), cashier.id, globex, acme, false);
    expect(found, `\n${found.join('\n')}`).toEqual([]);
  });

  it('the administrator of Globex, asking about everything in Acme', async () => {
    const { f, cashier, acme, globex } = await world();
    const found = await leaks(f, f.user('dora'), cashier.id, acme, globex, false);
    expect(found, `\n${found.join('\n')}`).toEqual([]);
  });
});

describe('the platform administrator does learn what is missing', () => {
  it('is told a scope does not exist, and can use one that does', async () => {
    const { f, acme } = await world();
    const missing = await seen(
      () => f.axeda.assignments.listForScope(f.admin, company(FAKE), page),
      [FAKE],
    );
    expect(missing).toBe('AXEDA_INVALID_INPUT: The company does not exist.');
    const existing = await seen(
      () => f.axeda.assignments.listForScope(f.admin, company(acme.company), page),
      [],
    );
    expect(existing).toBe('allowed');
  });

  it('the administrator of Acme still lists their own scope', async () => {
    const { f, acme } = await world();
    const own = await seen(
      () => f.axeda.assignments.listForScope(f.user('carl'), company(acme.company), page),
      [],
    );
    expect(own).toBe('allowed');
  });
});
