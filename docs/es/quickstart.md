# Inicio rápido

> Axeda aún no está en npm. Hasta la primera alpha, trabaja desde un clon del repositorio. Los
> comandos de abajo son los que ejecuta la propia suite de pruebas del ejemplo, así que siguen
> siendo ciertos.

## 1. Ejecuta el ejemplo

```bash
git clone https://github.com/teamblindmx/axeda.git && cd axeda
npm install
```

El ejemplo necesita tres ajustes. A propósito no hay valores por omisión para el secreto ni la URL.

```bash
export NODE_ENV=development
export BASE_URL=http://localhost:3000
export BETTER_AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))")"
npm start -w @axeda/example
```

En PowerShell usa `$env:NODE_ENV='development'` y así con los demás. Conserva las mismas
variables en la terminal donde ejecutes los siguientes comandos.

**Crea a la primera persona administradora.** Regístrate, abre el enlace de verificación y luego
promueve la cuenta:

```bash
curl -s -X POST $BASE_URL/api/auth/sign-up/email \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"email":"admin@example.com","name":"Admin","password":"a-long-password-123"}'
```

El ejemplo imprime el correo de verificación en su consola (`[dev mailer] … link=…`). Abre ese
enlace y, desde la raíz del repositorio:

```bash
npm run bootstrap -w @axeda/example -- admin@example.com
```

`bootstrap` es una **operación del servidor**, no una llamada a la API: nadie puede pedirla por
HTTP. Funciona una sola vez y solo con una cuenta cuyo correo esté verificado.

**Llama a la API.**

```bash
curl -s -c jar -X POST $BASE_URL/api/auth/sign-in/email \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"email":"admin@example.com","password":"a-long-password-123"}'

curl -s -b jar $BASE_URL/api/auth/axeda/me          # tus permisos: ["*"]
curl -s -b jar -X POST $BASE_URL/api/auth/axeda/company/create \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"slug":"acme","name":"ACME"}'
curl -s -b jar $BASE_URL/invoices                    # una ruta del ejemplo, protegida por Axeda
```

La historia completa —una cajera limitada a una compañía, invitaciones, bloqueos, el menú— corre
como prueba: [`apps/example/test/example.test.ts`](../../apps/example/test/example.test.ts).

## 2. Añade Axeda a tu aplicación

Instala (cuando se publique): `npm install @axeda/core @axeda/better-auth @axeda/express better-auth express`.

**Declara tus permisos y las funciones que trae tu aplicación.** Todo lo demás son datos.

```ts
import { axeda, secureAuthOptions, sessionPrincipal } from '@axeda/better-auth';

const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'],
  roles: {
    viewer: { name: 'Solo lectura', permissions: ['invoice:read', 'report:read'] },
    cashier: { name: 'Cajera', permissions: ['invoice:read', 'invoice:create'] },
  },
  // Axeda genera el secreto de la invitación; tú decides cómo se entrega.
  invitationDelivery: {
    acceptUrl: (token) => `https://app.example.com/accept?token=${encodeURIComponent(token)}`,
    send: ({ email, link }) => mailer.send({ to: email, subject: 'Te invitaron', link }),
  },
});
```

**Crea Better Auth con la configuración recomendada, más el plugin.**

```ts
const options = {
  ...secureAuthOptions({
    baseURL: 'https://api.example.com',
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: ['https://app.example.com'],
  }),
  database, // un manejador de better-sqlite3, un Pool de pg…
  plugins: [axedaPlugin],
  // Obligatorio porque el preset pide correos verificados:
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) =>
      mailer.send({ to: user.email, subject: 'Verifica', link: url }),
  },
};
await (await getMigrations(options)).runMigrations(); // crea las tablas de Axeda
const auth = betterAuth(options);
await auth.$context;
await axedaPlugin.start(); // comprueba que la base tiene transacciones reales y sincroniza tus funciones
```

`start()` se niega a continuar en una base de datos sin transacciones reales. En
[Seguridad](security.md) está qué corrige `secureAuthOptions()` y por qué.

**Móntalo y protege tus rutas.**

```ts
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { createAxedaExpress, resolveScope } from '@axeda/express';

const x = createAxedaExpress({
  axeda: axedaPlugin.instance(),
  principal: sessionPrincipal(auth),
  trustedOrigins: ['https://app.example.com'],
});

const app = express();
app.all('/api/auth/*splat', toNodeHandler(auth)); // ANTES de express.json()
app.use(express.json());

app.get(
  '/companies/:companyId/invoices',
  x.requirePermission('invoice:read', { scope: resolveScope({ company: 'companyId' }) }),
  (req, res) => res.json({ company: req.params.companyId }),
);
```

Hay más patrones (negocios, listados, un recurso concreto) en [Proteger rutas](express.md).

**Desde el navegador,** usa el cliente tipado:

```ts
import { createAuthClient } from 'better-auth/client';
import { axedaClient } from '@axeda/better-auth/client';

const client = createAuthClient({ baseURL: 'https://api.example.com', plugins: [axedaClient()] });
const { data } = await client.axeda.menu({
  query: { scopeType: 'company', scopeId, locale: 'es' },
});
```

## Problemas frecuentes

| Ves                                                                   | Causa y solución                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AXEDA_INVALID_CONFIG … session.cookieCache`                          | Axeda no corre con la caché de cookie de Better Auth: un permiso revocado seguiría vigente hasta que la cookie caduque. Desactívala |
| `AXEDA_INVALID_CONFIG … disableCSRFCheck` (o `disableOriginCheck`)    | Esas opciones quitan la defensa de todos los endpoints `/axeda/*`. Quítalas                                                         |
| `AXEDA_TRANSACTIONS_UNSUPPORTED`                                      | El adaptador de base de datos no tiene transacciones reales. Usa SQLite o PostgreSQL                                                |
| El inicio de sesión responde `403` justo tras registrarse             | El preset exige correo verificado. Abre el enlace que entregó tu `sendVerificationEmail`                                            |
| `429` mientras pruebas                                                | El preset limita por dirección el inicio de sesión (5/min) y el registro (5/5 min)                                                  |
| Better Auth registra `Field roleIds … Expected string[] but got TEXT` | Cosmético en SQLite: Better Auth compara los campos `string[]` con una columna JSON y SQLite no la tiene. No pasa nada              |
| Toda ruta protegida responde `403` a una persona administradora       | Revisa el alcance de la ruta: un id de compañía que no existe se deniega igual que un permiso que falta                             |
