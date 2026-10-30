import { afterEach, describe, expect, it } from 'vitest';
import type { DeniedEvent } from '../src/index.js';
import { APP, EVIL, closeAll, startApp } from './support/app.js';

afterEach(closeAll);

/**
 * Una aplicación cuyo gancho guarda lo que recibe y luego ejecuta `hook` TAL CUAL: no es `async`,
 * para que un error síncrono de `hook` llegue como error síncrono (y no como una promesa rechazada).
 */
async function withHook(options: { hook?: (event: DeniedEvent) => void | Promise<void> } = {}) {
  const events: DeniedEvent[] = [];
  const t = await startApp({
    onDenied: (event) => {
      events.push(event);
      return options.hook?.(event);
    },
  });
  return { t, events };
}

describe('onDenied tells the application what was refused, without changing the answer', () => {
  it('reports a missing session', async () => {
    const { t, events } = await withHook();
    const reply = await t.call('/reports');
    expect(reply.status).toBe(401);
    expect(events).toEqual([
      expect.objectContaining({
        reason: 'unauthenticated',
        detail: 'no-session',
        method: 'GET',
        path: '/reports',
        userId: null,
      }),
    ]);
  });

  it('reports who was refused, which permission and why', async () => {
    const { t, events } = await withHook();
    const ana = await t.signUp('ana');
    const acme = await t.company('acme');
    const reply = await t.call(`/companies/${acme}/invoices`, { cookie: ana.cookie });
    expect(reply.status).toBe(403);
    expect(events).toEqual([
      expect.objectContaining({
        reason: 'forbidden',
        detail: 'missing-permission',
        permission: 'invoice:read',
        userId: ana.id,
        path: `/companies/${acme}/invoices`,
      }),
    ]);
  });

  it('tells the owner apart what the client cannot be told: a missing scope, a mismatch, a malformed one', async () => {
    const { t, events } = await withHook();
    const boss = await t.signUp('boss');
    await t.give(boss.id, ['*'], { type: 'global' });
    const acme = await t.company('acme');
    const globex = await t.company('globex');
    const shop = await t.business('shop', acme);
    const cookie = boss.cookie;

    const bodies = [
      await t.call('/companies/does-not-exist/invoices', { cookie }),
      await t.call(`/companies/${globex}/businesses/${shop}/invoices`, { cookie }),
      await t.call('/invoices?companyId=', { cookie }),
    ];
    // Al cliente le llega lo mismo en los tres casos…
    expect(new Set(bodies.map((b) => b.status))).toEqual(new Set([403]));
    expect(new Set(bodies.map((b) => JSON.stringify(b.body))).size).toBe(1);
    // …y a quien administra la aplicación, el motivo exacto.
    expect(events.map((e) => e.detail)).toEqual([
      'scope-not-found',
      'scope-mismatch',
      'malformed-scope',
    ]);
  });

  it('reports a 404 as not-found', async () => {
    const { t, events } = await withHook();
    const ana = await t.signUp('ana');
    const reply = await t.call('/hidden/nope', { cookie: ana.cookie });
    expect(reply.status).toBe(404);
    expect(events[0]).toMatchObject({ reason: 'not-found', detail: 'scope-not-found' });
  });

  it('reports a cross-site write', async () => {
    const { t, events } = await withHook();
    const ana = await t.signUp('ana');
    const reply = await t.call('/me', { method: 'POST', cookie: ana.cookie, origin: EVIL });
    expect(reply.status).toBe(403);
    expect(events).toEqual([
      expect.objectContaining({ reason: 'cross-site', detail: 'cross-site-write', method: 'POST' }),
    ]);
  });

  it('stays quiet when the request is allowed', async () => {
    const { t, events } = await withHook();
    const boss = await t.signUp('boss');
    await t.give(boss.id, ['*'], { type: 'global' });
    expect((await t.call('/reports', { cookie: boss.cookie })).status).toBe(200);
    expect((await t.call('/me', { cookie: boss.cookie, origin: APP })).status).toBe(200);
    expect(events).toEqual([]);
  });

  it('never carries cookies, headers, the query string or the body', async () => {
    const { t, events } = await withHook();
    const ana = await t.signUp('ana');
    await t.call('/invoices?companyId=secret-token-in-the-query', { cookie: ana.cookie });
    await t.call('/me', {
      method: 'POST',
      cookie: ana.cookie,
      origin: EVIL,
      body: { password: 'hunter2' },
    });
    const text = JSON.stringify(events);
    expect(events.length).toBe(2);
    for (const secret of ['secret-token-in-the-query', 'hunter2', ana.cookie, 'better-auth']) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(
      [
        'detail',
        'ip',
        'method',
        'path',
        'permission',
        'reason',
        'status',
        'userAgent',
        'userId',
      ].sort(),
    );
  });

  it('clips long, request-controlled values', async () => {
    const { t, events } = await withHook();
    const reply = await t.call(`/companies/${'a'.repeat(2000)}/invoices`, {
      headers: { 'user-agent': 'x'.repeat(1000) },
    });
    expect(reply.status).toBe(401);
    expect(events).toHaveLength(1);
    expect(events[0]?.path.length).toBe(512);
    expect(events[0]?.userAgent?.length).toBe(255);
  });

  it('a hook that throws, or rejects, changes nothing: the answer is the same and the server stays up', async () => {
    const throwing = await withHook({
      hook: () => {
        throw new Error('the logger is down');
      },
    });
    const first = await throwing.t.call('/reports');
    expect(first.status).toBe(401);
    expect(first.body).toMatchObject({ code: 'AXEDA_UNAUTHENTICATED' });
    expect(throwing.events).toHaveLength(1);
    // El error del gancho no llega al manejador de errores de la aplicación como si la ruta hubiera fallado.
    expect(throwing.t.errors).toEqual([]);

    const rejecting = await withHook({
      hook: () => Promise.reject(new Error('the logger is down')),
    });
    expect((await rejecting.t.call('/reports')).status).toBe(401);
    // Si la promesa rechazada quedara sin atender, Node tumbaría el proceso de pruebas.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await rejecting.t.call('/reports')).status).toBe(401);
    expect(rejecting.t.errors).toEqual([]);
  });

  it('works without a hook, as before', async () => {
    const t = await startApp();
    expect((await t.call('/reports')).status).toBe(401);
  });
});
