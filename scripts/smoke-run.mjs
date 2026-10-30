// Se ejecuta DENTRO del proyecto vacío de `scripts/smoke.mjs`, con los paquetes ya instalados
// desde sus tarballs. Es una historia corta pero completa; no importa nada del repositorio.
import assert from 'node:assert/strict';
import { createServer as createProbe } from 'node:net';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import Database from 'better-sqlite3';
import express from 'express';
import { createAxeda } from '@axeda/core';
import { axeda, secureAuthOptions, sessionPrincipal } from '@axeda/better-auth';
import { axedaClient } from '@axeda/better-auth/client';
import { createAxedaExpress, resolveScope } from '@axeda/express';
import { createMemoryPersistence, createMemoryUserDirectory } from '@axeda/testing';

const PASSWORD = 'correct-horse-battery-12';
const step = (text) => console.log(`  ✔ ${text}`);

async function freePort() {
  const probe = createProbe();
  await new Promise((resolve) => probe.listen(0, resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const port = await freePort();
const origin = `http://localhost:${port}`;
const outbox = [];

const plugin = axeda({
  permissions: ['invoice:read'],
  roles: { viewer: ['invoice:read'] },
});
const options = {
  ...secureAuthOptions({
    environment: 'development',
    baseURL: origin,
    secret: 'k3Jx9Qp2Zr7Lm4Vb8Nc1Td6Wy5Hs0Ga3Fe9Uo2Ri7Pq',
    trustedOrigins: [origin],
  }),
  database: new Database(':memory:'),
  plugins: [plugin],
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => void outbox.push({ to: user.email, url }),
  },
};
await (await getMigrations(options)).runMigrations();
const auth = betterAuth(options);
await auth.$context;
await plugin.start();
const core = plugin.instance();
step('Better Auth starts with the Axeda plugin and the secure preset');

const x = createAxedaExpress({
  axeda: core,
  principal: sessionPrincipal(auth),
  trustedOrigins: [origin],
});
const app = express();
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json());
app.get(
  '/companies/:companyId/invoices',
  x.requirePermission('invoice:read', { scope: resolveScope({ company: 'companyId' }) }),
  (_request, response) => void response.json({ ok: true }),
);
const server = await new Promise((resolve) => {
  const listening = app.listen(port, () => resolve(listening));
});

let addresses = 0;
const send = (url, init = {}) =>
  fetch(url, {
    redirect: 'manual',
    ...init,
    headers: {
      origin,
      'x-forwarded-for': `10.0.0.${++addresses}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

async function register(name) {
  const email = `${name}@example.com`;
  const signUp = await send(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    body: JSON.stringify({ email, name, password: PASSWORD }),
  });
  assert.equal(signUp.status, 200, 'sign-up');
  const mail = outbox.findLast((item) => item.to === email);
  assert.ok(mail, 'verification email delivered');
  await send(mail.url);
  const signIn = await send(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signIn.status, 200, 'sign-in after verifying the email');
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const session = await (
    await send(`${origin}/api/auth/get-session`, { headers: { cookie } })
  ).json();
  return { id: session.user.id, cookie };
}

const admin = await register('admin');
const ana = await register('ana');
step('people register, verify their email and sign in');

await core.bootstrap({ userId: admin.id });
const root = { userId: admin.id };
const acme = await core.companies.create(root, { slug: 'acme', name: 'ACME' });
const globex = await core.companies.create(root, { slug: 'globex', name: 'Globex' });
const viewer = (await core.roles.list(root, { limit: 50 })).items.find(
  (role) => role.key === 'viewer',
);
assert.ok(viewer, 'the role declared in code exists');
await core.assignments.assign(root, {
  userId: ana.id,
  roleId: viewer.id,
  scope: { type: 'company', id: acme.id },
});
step('the first administrator is bootstrapped; companies, roles and assignments work');

const get = (path, cookie) => send(`${origin}${path}`, cookie ? { headers: { cookie } } : {});
assert.equal((await get(`/companies/${acme.id}/invoices`)).status, 401);
assert.equal((await get(`/companies/${acme.id}/invoices`, ana.cookie)).status, 200);
assert.equal((await get(`/companies/${globex.id}/invoices`, ana.cookie)).status, 403);
assert.equal((await get(`/companies/${globex.id}/invoices`, admin.cookie)).status, 200);
step('Express routes: 401 without a session, 200 in her company, 403 in another, admin everywhere');

assert.equal(typeof axedaClient, 'function');
const users = createMemoryUserDirectory([]);
const memory = createAxeda(
  { permissions: ['invoice:read'] },
  { persistence: createMemoryPersistence(), users, userAdmin: users },
);
assert.equal(await memory.can({ userId: 'nobody' }, 'invoice:read'), false);
step('the client plugin, core and testing packages load and deny by default');

server.close();
server.closeAllConnections();
process.exit(0);
