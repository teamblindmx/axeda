/**
 * Demo de Axeda: un servidor real (Better Auth + el plugin de Axeda + SQLite en memoria) y un
 * guion que cuenta la historia completa por HTTP.
 *
 *   npm run demo            cuenta la historia y termina
 *   npm run demo -- --serve deja el servidor encendido para probarlo con curl
 */
import { createServer } from 'node:http';
import { createServer as createProbe, type AddressInfo } from 'node:net';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import Database from 'better-sqlite3';
import { axeda } from '@axeda/better-auth';

const SERVE = process.argv.includes('--serve');

/** Un puerto libre (o el 3000 con --serve): Better Auth necesita saber su URL al crearse. */
async function freePort(): Promise<number> {
  const probe = createProbe();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
const PORT = SERVE ? 3000 : await freePort();
const PASSWORD = 'una-contrasena-larga-y-segura-123';

// 1. La aplicación declara qué permisos existen y qué funciones trae de fábrica.
const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'],
  roles: {
    viewer: { name: 'Solo lectura', permissions: ['invoice:read', 'report:read'] },
  },
});

// 2. Better Auth autentica; Axeda solo autoriza. Un plugin y listo.
const config = {
  secret: 'demo-secret-demo-secret-demo-secret-0123456789',
  baseURL: `http://localhost:${PORT}`,
  database: new Database(':memory:'),
  emailAndPassword: { enabled: true },
  plugins: [axedaPlugin],
  rateLimit: { enabled: false },
};
await (await getMigrations(config)).runMigrations();
const auth = betterAuth(config);
await auth.$context;
await axedaPlugin.start();

const server = createServer(toNodeHandler(auth));
await new Promise<void>((resolve) => server.listen(PORT, resolve));
const origin = `http://localhost:${PORT}`;

// --- pequeñas ayudas para contar la historia -------------------------------------------------
const paint = (code: number, text: string) => `\u001B[${code}m${text}\u001B[0m`;
const title = (text: string) => console.log(`\n${paint(1, paint(36, `▌ ${text}`))}`);
const say = (text: string) => console.log(`  ${text}`);

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function http(
  method: 'GET' | 'POST',
  path: string,
  cookie: string,
  data?: unknown,
  query = '',
) {
  const response = await fetch(`${origin}/api/auth${path}${query}`, {
    method,
    headers: {
      cookie,
      origin,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null } satisfies Reply;
}

function show(label: string, reply: Reply, expected: number, code?: string) {
  const ok = reply.status === expected && (code === undefined || reply.body?.code === code);
  const mark = ok ? paint(32, '✔') : paint(31, '✘ INESPERADO');
  const detail = reply.status >= 400 ? ` ${paint(33, reply.body?.code ?? '')}` : '';
  console.log(`  ${mark} ${label} → ${reply.status}${detail}`);
  if (!ok) {
    throw new Error(
      `${label}: se esperaba ${expected} ${code ?? ''} y llegó ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  }
}

async function signUp(name: string) {
  const response = await auth.api.signUpEmail({
    body: { email: `${name}@demo.dev`, password: PASSWORD, name },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, cookie };
}

// --- la historia -----------------------------------------------------------------------------
title('1. Hay tres personas con cuenta, pero nadie tiene permisos');
const root = await signUp('root');
const maria = await signUp('maria');
const luis = await signUp('luis');
show(
  'maria pide crear una función',
  await http('POST', '/axeda/role/create', maria.cookie, {
    key: 'x',
    name: 'x',
    permissions: ['invoice:read'],
  }),
  403,
  'AXEDA_FORBIDDEN',
);
say('Denegar por defecto: sin función asignada no se puede nada.');

title('2. El primer administrador se crea desde el servidor (no hay contraseñas maestras)');
await axedaPlugin.instance().bootstrap({ userId: root.id });
show('root ya es administrador global', await http('GET', '/axeda/me', root.cookie), 200);
try {
  await axedaPlugin.instance().bootstrap({ userId: luis.id });
} catch (error) {
  say(`Un segundo bootstrap se rechaza: ${(error as { code: string }).code}`);
}

title('3. El administrador crea funciones (conjuntos de permisos)');
const cashier = await http('POST', '/axeda/role/create', root.cookie, {
  key: 'cashier',
  name: 'Cajero',
  permissions: ['invoice:read', 'invoice:create'],
});
show('crea "cajero"', cashier, 200);
const companyAdmin = await http('POST', '/axeda/role/create', root.cookie, {
  key: 'company-admin',
  name: 'Admin de compañía',
  permissions: ['axeda:assignment:manage', 'invoice:read', 'invoice:create'],
});
show('crea "admin de compañía"', companyAdmin, 200);
const viewer = (await http('GET', '/axeda/role/list', root.cookie)).body.items.find(
  (role: { key: string }) => role.key === 'viewer',
);
say(
  `La función "${viewer.name}" viene declarada en el código y es de solo lectura (managed: ${viewer.managed}).`,
);
show(
  'intenta borrar la función del código',
  await http('POST', '/axeda/role/delete', root.cookie, { id: viewer.id }),
  409,
  'AXEDA_ROLE_MANAGED',
);

title('4. María administra la compañía ACME; Luis será cajero ahí');
show(
  'root hace admin de ACME a maria',
  await http('POST', '/axeda/assignment/create', root.cookie, {
    userId: maria.id,
    roleId: companyAdmin.body.id,
    scope: { type: 'company', id: 'acme' },
  }),
  200,
);
show(
  'maria asigna "cajero" a luis en ACME',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: cashier.body.id,
    scope: { type: 'company', id: 'acme' },
  }),
  200,
);

title('5. Lo que María NO puede hacer (aquí vive la seguridad)');
show(
  'asignar en OTRA compañía',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: cashier.body.id,
    scope: { type: 'company', id: 'globex' },
  }),
  403,
  'AXEDA_FORBIDDEN',
);
show(
  'asignar a nivel GLOBAL',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: cashier.body.id,
    scope: { type: 'global' },
  }),
  403,
  'AXEDA_FORBIDDEN',
);
const powerful = await http('POST', '/axeda/role/create', root.cookie, {
  key: 'deleter',
  name: 'Borra facturas',
  permissions: ['invoice:delete'],
});
show(
  'dar una función con más permisos que los suyos (escalada)',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: powerful.body.id,
    scope: { type: 'company', id: 'acme' },
  }),
  403,
  'AXEDA_FORBIDDEN',
);
show(
  'editarse a sí misma una función para añadirse poder',
  await http('POST', '/axeda/role/update', maria.cookie, {
    id: companyAdmin.body.id,
    version: 1,
    permissions: ['*'],
  }),
  403,
  'AXEDA_FORBIDDEN',
);

title('6. Luis tiene permisos solo donde se los dieron');
const acme = { type: 'company' as const, companyId: 'acme' };
const core = axedaPlugin.instance();
const check = async (
  label: string,
  permission: string,
  target?: typeof acme | { type: 'company'; companyId: string },
) => {
  const allowed = await core.can({ userId: luis.id }, permission, target);
  console.log(`  ${allowed ? paint(32, 'puede   ') : paint(31, 'NO puede')} ${label}`);
};
await check('invoice:create en ACME', 'invoice:create', acme);
await check('invoice:create en GLOBEX', 'invoice:create', { type: 'company', companyId: 'globex' });
await check('invoice:delete en ACME', 'invoice:delete', acme);
const filter = await core.scopeFilter({ userId: luis.id }, 'invoice:read');
say(`Para filtrar tus consultas (anti-IDOR): ${JSON.stringify(filter)}`);

title('7. Revocar surte efecto en la siguiente petición');
const mine = (
  await http(
    'GET',
    '/axeda/assignment/list',
    maria.cookie,
    undefined,
    '?scopeType=company&scopeId=acme',
  )
).body.items.find((item: { userId: string }) => item.userId === luis.id);
show(
  'maria revoca a luis',
  await http('POST', '/axeda/assignment/revoke', maria.cookie, { id: mine.id }),
  200,
);
await check('invoice:create en ACME (tras revocar)', 'invoice:create', acme);

title('8. Todo queda en la auditoría');
const log = await http('GET', '/axeda/audit/list', root.cookie, undefined, '?limit=50');
for (const event of [...log.body.items].reverse()) {
  const mark = event.outcome === 'success' ? paint(32, 'ok    ') : paint(31, 'DENEGADO');
  console.log(
    `  ${mark} ${event.action.padEnd(18)} actor=${event.actorId === null ? 'sistema' : event.actorId.slice(0, 6)} ${event.metadata.reason ?? event.metadata.roleKey ?? event.metadata.key ?? ''}`,
  );
}

if (SERVE) {
  title('Servidor encendido en http://localhost:3000');
  say('Prueba con curl (cookie de root):');
  say(`curl -s ${origin}/api/auth/axeda/me -H "cookie: ${root.cookie}"`);
  say('Ctrl+C para salir.');
} else {
  server.close();
  console.log(`\n${paint(32, 'Demo completada: todo se comportó como se esperaba.')}\n`);
}
