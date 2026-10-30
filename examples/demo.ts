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
const PASSWORD = 'una-contrasena-larga-y-segura-123';

/** Un puerto libre (o el 3000 con --serve): Better Auth necesita saber su URL al crearse. */
async function freePort(): Promise<number> {
  const probe = createProbe();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
const PORT = SERVE ? 3000 : await freePort();
const origin = `http://localhost:${PORT}`;

// 1. La aplicación declara qué permisos existen y qué funciones trae de fábrica. Y cómo se
//    envían las invitaciones: Axeda genera el secreto; tú decides el correo.
const outbox: Array<{ email: string; link: string }> = [];
const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'],
  roles: {
    viewer: { name: 'Solo lectura', permissions: ['invoice:read', 'report:read'] },
  },
  invitationDelivery: {
    acceptUrl: (token) => `https://app.example/aceptar?token=${encodeURIComponent(token)}`,
    send: async ({ email, link }) => void outbox.push({ email, link }),
  },
  publicIdentity: true,
  // El menú se declara en el código; cada persona recibe solo lo que puede usar.
  menus: [
    { key: 'facturacion', label: { es: 'Facturación', en: 'Billing' }, icon: 'receipt', order: 1 },
    {
      key: 'facturas',
      parent: 'facturacion',
      path: '/facturas',
      label: { es: 'Facturas', en: 'Invoices' },
      requires: 'invoice:read',
      actions: ['invoice:create', 'invoice:delete'],
    },
    {
      key: 'reportes',
      path: '/reportes',
      label: { es: 'Reportes', en: 'Reports' },
      requires: 'report:read',
      order: 2,
    },
  ],
});

// 2. Better Auth autentica; Axeda solo autoriza. Un plugin y listo.
const config = {
  secret: 'demo-secret-demo-secret-demo-secret-0123456789',
  baseURL: origin,
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
): Promise<Reply> {
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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Comprueba el estado Y el código de error: un 403 por otro motivo no cuenta como acierto. */
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
  return reply.body;
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

const FORBIDDEN = 'AXEDA_FORBIDDEN';
const core = axedaPlugin.instance();

// --- la historia -----------------------------------------------------------------------------
title('1. Hay cuatro personas con cuenta, pero nadie tiene permisos');
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
  FORBIDDEN,
);
say('Denegar por defecto: sin función asignada no se puede nada.');

title('2. El primer administrador se crea desde el servidor (no hay contraseñas maestras)');
await core.bootstrap({ userId: root.id });
show('root ya es administrador global', await http('GET', '/axeda/me', root.cookie), 200);
try {
  await core.bootstrap({ userId: luis.id });
} catch (error) {
  say(`Un segundo bootstrap se rechaza: ${(error as { code: string }).code}`);
}

title('3. El administrador crea dos compañías y las funciones');
const acme = show(
  'crea la compañía ACME',
  await http('POST', '/axeda/company/create', root.cookie, {
    slug: 'acme',
    name: 'ACME',
    logoUrl: 'https://cdn.example/acme.png',
  }),
  200,
);
const globex = show(
  'crea la compañía GLOBEX',
  await http('POST', '/axeda/company/create', root.cookie, { slug: 'globex', name: 'GLOBEX' }),
  200,
);
const cashier = show(
  'crea "cajero"',
  await http('POST', '/axeda/role/create', root.cookie, {
    key: 'cashier',
    name: 'Cajero',
    permissions: ['invoice:read', 'invoice:create'],
  }),
  200,
);
const companyAdmin = show(
  'crea "admin de compañía"',
  await http('POST', '/axeda/role/create', root.cookie, {
    key: 'company-admin',
    name: 'Admin de compañía',
    permissions: [
      'axeda:assignment:manage',
      'axeda:business:manage',
      'axeda:invitation:manage',
      'invoice:read',
      'invoice:create',
    ],
  }),
  200,
);
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

title('4. María administra ACME: crea un negocio y pone a Luis de cajero ahí');
show(
  'root hace admin de ACME a maria',
  await http('POST', '/axeda/assignment/create', root.cookie, {
    userId: maria.id,
    roleId: companyAdmin.id,
    scope: { type: 'company', id: acme.id },
  }),
  200,
);
const shop = show(
  'maria crea el negocio "Sucursal Centro"',
  await http('POST', '/axeda/business/create', maria.cookie, {
    companyId: acme.id,
    slug: 'centro',
    name: 'Sucursal Centro',
  }),
  200,
);
show(
  'maria asigna "cajero" a luis en ESE negocio',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: cashier.id,
    scope: { type: 'business', id: shop.id },
  }),
  200,
);
say('La compañía del negocio sale de la base de datos, nunca de la petición.');

title('5. Lo que María NO puede hacer (aquí vive la seguridad)');
show(
  'ver la compañía GLOBEX (ni siquiera sabe que existe)',
  await http('GET', '/axeda/company/get', maria.cookie, undefined, `?id=${globex.id}`),
  404,
  'AXEDA_COMPANY_NOT_FOUND',
);
show(
  'crear un negocio en GLOBEX',
  await http('POST', '/axeda/business/create', maria.cookie, {
    companyId: globex.id,
    slug: 'x',
    name: 'X',
  }),
  404,
  'AXEDA_COMPANY_NOT_FOUND',
);
show(
  'asignar en OTRA compañía',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: cashier.id,
    scope: { type: 'company', id: globex.id },
  }),
  403,
  FORBIDDEN,
);
show(
  'asignar a nivel GLOBAL',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: cashier.id,
    scope: { type: 'global' },
  }),
  403,
  FORBIDDEN,
);
const powerful = show(
  '(root crea "borra facturas")',
  await http('POST', '/axeda/role/create', root.cookie, {
    key: 'deleter',
    name: 'Borra facturas',
    permissions: ['invoice:delete'],
  }),
  200,
);
show(
  'dar una función con más permisos que los suyos (escalada)',
  await http('POST', '/axeda/assignment/create', maria.cookie, {
    userId: luis.id,
    roleId: powerful.id,
    scope: { type: 'company', id: acme.id },
  }),
  403,
  FORBIDDEN,
);
show(
  'desactivar su propia compañía',
  await http('POST', '/axeda/company/set-status', maria.cookie, {
    id: acme.id,
    version: 1,
    status: 'inactive',
  }),
  403,
  FORBIDDEN,
);

title('6. Luis tiene permisos solo donde se los dieron');
const inShop = { type: 'business' as const, companyId: acme.id, businessId: shop.id };
const check = async (
  label: string,
  permission: string,
  target?: Parameters<typeof core.can>[2],
) => {
  const allowed = await core.can({ userId: luis.id }, permission, target);
  console.log(`  ${allowed ? paint(32, 'puede   ') : paint(31, 'NO puede')} ${label}`);
};
await check('invoice:create en la sucursal', 'invoice:create', inShop);
await check('invoice:create en el resto de ACME', 'invoice:create', {
  type: 'company',
  companyId: acme.id,
});
await check('invoice:create en GLOBEX', 'invoice:create', {
  type: 'company',
  companyId: globex.id,
});
await check('invoice:delete en la sucursal', 'invoice:delete', inShop);
say(
  `Para filtrar tus consultas (anti-IDOR): ${JSON.stringify(await core.scopeFilter({ userId: luis.id }, 'invoice:read'))}`,
);

title('7. Invitar por correo: el secreto viaja solo por el correo');
const invitation = show(
  'maria invita a ana@demo.dev como cajero de ACME',
  await http('POST', '/axeda/invitation/create', maria.cookie, {
    email: 'ana@demo.dev',
    scope: { type: 'company', id: acme.id },
    roleIds: [cashier.id],
  }),
  200,
);
say(`La API no devuelve el secreto (campos: ${Object.keys(invitation).join(', ')}).`);
const mail = outbox.at(-1);
say(`Tu callback "send" recibe el enlace: ${mail?.link.slice(0, 52)}…`);
const ana = await signUp('ana');
const token = new URL(mail?.link ?? '').searchParams.get('token');
show(
  'ana acepta sin haber verificado su correo',
  await http('POST', '/axeda/invitation/accept', ana.cookie, { token }),
  400,
  'AXEDA_INVITATION_INVALID',
);
await (
  await auth.$context
).adapter.update({
  model: 'user',
  where: [{ field: 'id', value: ana.id }],
  update: { emailVerified: true },
});
say('(Ana verifica su correo; en producción lo hace el enlace de Better Auth.)');
const mallory = await signUp('mallory');
await (
  await auth.$context
).adapter.update({
  model: 'user',
  where: [{ field: 'id', value: mallory.id }],
  update: { emailVerified: true },
});
show(
  'mallory (otra cuenta) intenta usar el mismo enlace',
  await http('POST', '/axeda/invitation/accept', mallory.cookie, { token }),
  400,
  'AXEDA_INVITATION_INVALID',
);
show(
  'ana acepta con su correo verificado',
  await http('POST', '/axeda/invitation/accept', ana.cookie, { token }),
  200,
);
show(
  'el enlace ya no sirve una segunda vez',
  await http('POST', '/axeda/invitation/accept', ana.cookie, { token }),
  400,
  'AXEDA_INVITATION_INVALID',
);

title('8. Revocar surte efecto en la siguiente petición');
const mine = (
  await http(
    'GET',
    '/axeda/assignment/list',
    maria.cookie,
    undefined,
    `?scopeType=business&scopeId=${shop.id}`,
  )
).body.items.find((item: { userId: string }) => item.userId === luis.id);
show(
  'maria revoca a luis',
  await http('POST', '/axeda/assignment/revoke', maria.cookie, { id: mine.id }),
  200,
);
await check('invoice:create en la sucursal (tras revocar)', 'invoice:create', inShop);

title('9. Borrar una compañía la silencia al instante, y se puede restaurar');
const anaTarget = { type: 'company' as const, companyId: acme.id };
const anaCan = async () => core.can({ userId: ana.id }, 'invoice:create', anaTarget);
say(`Ana puede crear facturas en ACME: ${await anaCan()}`);
show(
  'root borra ACME (periodo de gracia: 30 días)',
  await http('POST', '/axeda/company/delete', root.cookie, { id: acme.id, version: 1 }),
  200,
);
say(`Ana puede crear facturas en ACME: ${await anaCan()}  ← sin tocar ninguna asignación`);
show(
  'la identidad pública de ACME ya no responde',
  await http('GET', '/axeda/public/identity', '', undefined, '?company=acme'),
  404,
  'AXEDA_COMPANY_NOT_FOUND',
);
const gone = (await http('GET', '/axeda/company/list', root.cookie, undefined, '?deleted=only'))
  .body.items[0];
show(
  'root la restaura',
  await http('POST', '/axeda/company/restore', root.cookie, { id: acme.id, version: gone.version }),
  200,
);
say(`Ana puede crear facturas en ACME: ${await anaCan()}`);
const identity = show(
  'identidad pública de ACME (sin sesión)',
  await http('GET', '/axeda/public/identity', '', undefined, '?company=acme'),
  200,
);
say(`Solo nombre y logos: ${JSON.stringify(identity)}`);

title('10. Administrar usuarios: bloquear corta todo, y no se puede tocar a quien tiene más poder');
const userAdminRole = show(
  '(root crea "soporte")',
  await http('POST', '/axeda/role/create', root.cookie, {
    key: 'support',
    name: 'Soporte',
    permissions: ['axeda:user:manage'],
  }),
  200,
);
const soporte = await signUp('soporte');
show(
  'root da "soporte" a una persona',
  await http('POST', '/axeda/assignment/create', root.cookie, {
    userId: soporte.id,
    roleId: userAdminRole.id,
    scope: { type: 'global' },
  }),
  200,
);
const nuevo = show(
  'soporte crea una cuenta SIN contraseña',
  await http('POST', '/axeda/user/create', soporte.cookie, {
    email: 'nuevo@demo.dev',
    name: 'Nuevo',
  }),
  200,
);
say(
  `La cuenta nace sin credencial (emailVerified: ${nuevo.emailVerified}); la persona la establece por el flujo normal de Better Auth.`,
);
show(
  'soporte intenta bloquear a root',
  await http('POST', '/axeda/user/ban', soporte.cookie, { id: root.id }),
  403,
  FORBIDDEN,
);
show(
  'soporte intenta bloquearse a sí mismo',
  await http('POST', '/axeda/user/ban', soporte.cookie, { id: soporte.id }),
  400,
  'AXEDA_INVALID_INPUT',
);
say(
  `mallory tiene sesión abierta: /me → ${(await http('GET', '/axeda/me', mallory.cookie)).status}`,
);
show(
  'soporte bloquea a mallory',
  await http('POST', '/axeda/user/ban', soporte.cookie, { id: mallory.id, reason: 'abuso' }),
  200,
);
say(
  `su sesión se cerró al instante: /me → ${(await http('GET', '/axeda/me', mallory.cookie)).status}`,
);
const login = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ email: 'mallory@demo.dev', password: PASSWORD }),
});
say(
  `y no puede abrir otra: iniciar sesión → ${login.status} (${((await login.json()) as { code?: string }).code})`,
);
show(
  'soporte la desbloquea',
  await http('POST', '/axeda/user/unban', soporte.cookie, { id: mallory.id }),
  200,
);

title('11. El menú: cada persona ve solo lo que puede usar, en su idioma');
const verMenu = async (quien: { cookie: string }, idioma: string) =>
  (await http('GET', '/axeda/menu', quien.cookie, undefined, `?locale=${idioma}`)).body
    .items as Array<{
    label: string;
    children: Array<{ label: string; path: string; can: Record<string, boolean> }>;
  }>;
say(`root (todo): ${JSON.stringify((await verMenu(root, 'es')).map((n) => n.label))}`);
const menuDeAna = await verMenu(ana, 'es');
say(`ana (cajera de ACME) en global: ${JSON.stringify(menuDeAna)}  ← el menú depende del alcance`);
const menuAcme = (
  await http(
    'GET',
    '/axeda/menu',
    ana.cookie,
    undefined,
    `?scopeType=company&scopeId=${acme.id}&locale=es`,
  )
).body.items;
say(
  `ana en ACME: ${menuAcme[0].label} → ${menuAcme[0].children[0].label} (${menuAcme[0].children[0].path}), acciones: ${JSON.stringify(menuAcme[0].children[0].can)}`,
);
say('Un menú nunca muestra una opción sin su permiso; la seguridad la impone siempre el servidor.');

title('12. Todo queda en la auditoría');
const log = await http('GET', '/axeda/audit/list', root.cookie, undefined, '?limit=100');
for (const event of [...log.body.items].reverse()) {
  const mark = event.outcome === 'success' ? paint(32, 'ok      ') : paint(31, 'DENEGADO');
  const who = event.actorId === null ? 'sistema' : event.actorId.slice(0, 6);
  const note =
    event.metadata.reason ??
    event.metadata.roleKey ??
    event.metadata.key ??
    event.metadata.slug ??
    '';
  console.log(`  ${mark} ${event.action.padEnd(20)} actor=${who} ${note}`);
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
