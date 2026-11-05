# Configuración

Axeda **no lee ninguna variable de entorno**. Todo se configura en código, pasando opciones a cuatro
funciones. De dónde sale cada valor (una variable de entorno, un gestor de secretos, un archivo) lo decide
tu aplicación; la [última sección](#variables-de-entorno) muestra una organización típica.

| Configuras…                         | Con                                                            | Obligatorio                                                |
| ----------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Better Auth: URL, secreto, sesiones | [`secureAuthOptions({ … })`](#1-better-auth-secureauthoptions) | `baseURL`, `secret`, `trustedOrigins`                      |
| Better Auth: el resto               | tu propia llamada a `betterAuth({ … })`                        | `database`, `plugins`, un envío del correo de verificación |
| Lo que gestiona Axeda               | [`axeda({ … })`](#2-el-plugin-axeda)                           | `permissions`                                              |
| Las rutas de tu aplicación Express  | [`createAxedaExpress({ … })`](#3-express-createaxedaexpress)   | `axeda`, `principal`, y `trustedOrigins` o `csrf: false`   |

La configuración más corta que funciona, en el orden en que debe ejecutarse, está en el
[Inicio rápido](quickstart.md#2-añade-axeda-a-tu-aplicación). Esta página explica cada opción, qué valores
acepta y qué pasa cuando uno es incorrecto.

## Cuándo aparece un error

| Error                                                                                              | Aparece…                                   | Como                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `maxSessionAge` que no es un entero positivo                                                       | al llamar a `axeda({ … })`                 | `AXEDA_INVALID_CONFIG`                                              |
| Cualquier otra opción del plugin fuera de rango, mal formada o mal escrita **dentro** de un objeto | al crear Better Auth (`betterAuth({ … })`) | `AXEDA_INVALID_CONFIG`, con la ruta y el motivo                     |
| Una entrada débil de `secureAuthOptions`                                                           | al llamar a `secureAuthOptions({ … })`     | `AXEDA_INVALID_CONFIG`                                              |
| Una opción de Better Auth con la que Axeda no funciona                                             | al crear Better Auth                       | `AXEDA_INVALID_CONFIG`                                              |
| Las tablas de Axeda no existen (no migraste)                                                       | en `start()`, o en la primera petición     | el error propio de la base de datos (`no such table: axedaState` …) |
| La base de datos no tiene transacciones reales                                                     | en `start()`                               | `AXEDA_TRANSACTIONS_UNSUPPORTED`                                    |
| Una opción mal escrita en el **primer nivel** de `axeda({ … })` (`invitationDelivry`)              | **nunca**: se ignora                       | la función simplemente no se activa. Revisa la ortografía           |

Los errores de configuración nunca llegan a un navegador como tales: un cliente HTTP ve
`AXEDA_INTERNAL_ERROR` y el detalle queda en el registro de tu servidor
([códigos de error](reference.md#códigos-de-error)).

---

## 1. Better Auth: `secureAuthOptions`

`secureAuthOptions(input)` devuelve la parte de la configuración de Better Auth que Axeda recomienda. La
esparces dentro de tu propia configuración y añades lo que solo tú sabes. **Se niega a devolver** una
configuración débil (lanza `AXEDA_INVALID_CONFIG`).

```ts
import { betterAuth } from 'better-auth';
import { axeda, secureAuthOptions } from '@teamblind/axeda-better-auth';

const options = {
  ...secureAuthOptions({
    baseURL: 'https://api.example.com',
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: ['https://app.example.com'],
  }),
  database, // la tuya
  plugins: [axedaPlugin], // el tuyo
  emailVerification: { sendOnSignUp: true, sendVerificationEmail }, // el tuyo
};
```

### Entrada

| Opción                     | Tipo                                            | Por omisión     | Qué hace y qué se comprueba                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`                  | `string`                                        | — (obligatoria) | URL pública del servidor que ejecuta Better Auth. Puede llevar ruta (`/api/auth`); solo se comprueba su origen. En `production` debe ser `https`; en `development`, `http` solo se admite para `localhost`, `127.0.0.1` y `[::1]`                                    |
| `secret`                   | `string`                                        | — (obligatoria) | Al menos **32 caracteres** y al menos **8 distintos**: un secreto corto o repetitivo se rechaza. Genera uno con `openssl rand -base64 48`                                                                                                                            |
| `trustedOrigins`           | `string[]`                                      | — (obligatoria) | Los front ends que pueden llamar a la API con cookie y a los que se puede redirigir. Al menos uno. Cada uno debe ser solo un origen (`https://app.example.com`: sin ruta, sin consulta, sin credenciales) y **sin comodines**. `baseURL` ya cuenta como de confianza |
| `environment`              | `'production' \| 'development'`                 | `'production'`  | `production` exige `https` en todo y cookies `Secure`. `development` admite `http://localhost`                                                                                                                                                                       |
| `trustedProxies`           | `string[]` (IP o rangos CIDR)                   | `[]`            | Los proxies que tienes delante de tu API. Sin ellos solo se confía en un `X-Forwarded-For` de un único valor, porque una cadena la puede falsificar el cliente para evadir los límites de peticiones. Defínelo si estás detrás de un proxy                           |
| `rateLimitStorage`         | `'memory' \| 'database' \| 'secondary-storage'` | `'memory'`      | Dónde se llevan las cuentas de peticiones. `memory` es por proceso: con varias instancias el límite real se multiplica por el número de instancias. **Usa `database` con más de una instancia**                                                                      |
| `requireEmailVerification` | `boolean`                                       | `true`          | Iniciar sesión exige correo verificado. Las invitaciones solo las acepta un correo verificado, así que `false` se rechaza en `production`. Con `true` debes configurar `emailVerification.sendVerificationEmail`                                                     |

### Lo que fija por ti

| Área                   | Valor                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contraseñas            | De 12 a 128 caracteres; al restablecer la contraseña se cierran las sesiones                                                                                                                                                                                                    |
| Sesiones               | `expiresIn` 7 días (tiempo sin uso), `updateAge` 1 día, `freshAge` 15 minutos, **caché de cookie apagada**                                                                                                                                                                      |
| Cookies                | `HttpOnly`, `SameSite=Lax`, `Secure` en producción                                                                                                                                                                                                                              |
| Comprobación de origen | `disableCSRFCheck: false`, `disableOriginCheck: false`                                                                                                                                                                                                                          |
| Límites de peticiones  | 100 por minuto por dirección, y más estrictos al iniciar sesión (5 por minuto), registrarse (5 cada 5 minutos), pedir restablecer la contraseña (3 cada 5 minutos), restablecerla (5 cada 5 minutos), correo de verificación (3 cada 5 minutos) y verificar TOTP (5 por minuto) |

Puedes cambiar cualquiera poniendo tu propio valor **después** del spread. El spread es superficial: tu
`session` (o `advanced`, `rateLimit`, `emailAndPassword`) sustituye al objeto entero del preset, así que
copia los valores que quieras conservar. Axeda solo rechaza las cuatro opciones de abajo.

### Lo que añades tú

- `database`: mira [Bases de datos](reference.md#bases-de-datos) para ver lo que pide cada una.
- `plugins: [axedaPlugin]`, y el plugin `twoFactor` de Better Auth si alguna función usa `requireMfa`.
- `emailVerification.sendVerificationEmail`, obligatorio con el `requireEmailVerification: true` por omisión.
- `secondaryStorage`, si lo usas. Con él, Axeda lee el usuario de la base de datos en cada petición (una
  consulta más), porque Better Auth refresca la copia del usuario dentro de las sesiones en caché, pero la
  versión de permisos de Axeda no forma parte de ese refresco.

### Opciones con las que Axeda no funciona

Si alguna de estas es `true` cuando se crea Better Auth, Axeda lanza `AXEDA_INVALID_CONFIG` y el mensaje
dice por qué. Quitan una protección en la que se apoya cada endpoint `/axeda/*`.

| Opción                                 | Por qué se rechaza                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session.cookieCache.enabled`          | Una sesión revocada o un permiso cambiado seguirían valiendo hasta que caduque la cookie |
| `advanced.disableCSRFCheck`            | Cada endpoint `/axeda/*` usa cookie y quedaría abierto a peticiones desde otros sitios   |
| `advanced.disableOriginCheck`          | Las URL de retorno y redirección ya no se validarían contra `trustedOrigins`             |
| `advanced.ipAddress.disableIpTracking` | Los límites de peticiones y la auditoría necesitan la dirección del cliente              |

Axeda añade además su propio límite a sus endpoints, por dirección IP: **120 peticiones por minuto** para
`/axeda/*` y **30 por minuto** para el único endpoint que no necesita sesión (`/axeda/public/identity`).

---

## 2. El plugin: `axeda`

```ts
const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create'],
  roles: { viewer: ['invoice:read'] },
});
```

Solo `permissions` es obligatoria. Todas las demás opciones tienen un valor por omisión.

### Opciones

| Opción                         | Tipo                                         | Por omisión     | Valores aceptados                                        | Notas                                                                                                  |
| ------------------------------ | -------------------------------------------- | --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `permissions`                  | `string[]`                                   | — (obligatoria) | ver [Claves de permiso](#claves-de-permiso)              | El catálogo de tu aplicación                                                                           |
| `roles`                        | `Record<string, string[] \| RoleDefinition>` | `{}`            | ver [Funciones](#funciones-declaradas-en-código)         | Funciones que vienen con tu app; `start()` las crea y las mantiene sincronizadas                       |
| `menus`                        | `MenuDefinition[]`                           | `[]`            | ver [Elementos de menú](reference.md#elementos-del-menú) | Lo sirve `GET /axeda/menu`, filtrado por lo que puede hacer quien llama                                |
| `retention.graceDays`          | entero                                       | `30`            | de 0 a 3650                                              | Días que se conserva una compañía o negocio borrado antes de poder purgarse                            |
| `invitations.ttlHours`         | entero                                       | `72`            | de 1 a 720                                               | Vigencia por omisión de una invitación                                                                 |
| `invitations.maxRoles`         | entero                                       | `10`            | de 1 a 50                                                | Funciones que puede llevar una invitación                                                              |
| `limits.maxAssignmentsPerUser` | entero                                       | `50`            | de 1 a 10000                                             | Una concesión (o una invitación aceptada) que lo supere responde `AXEDA_LIMIT_EXCEEDED`                |
| `limits.maxPermissionsPerRole` | entero                                       | `100`           | de 1 a 10000                                             | Una función con más permisos que esto se rechaza                                                       |
| `limits.maxCachedUsers`        | entero                                       | `10000`         | de 1 a 10000                                             | Usuarios cuyos permisos guarda cada proceso en memoria. La memoria crece con este valor                |
| `invitationDelivery`           | `{ acceptUrl(token), send(message) }`        | apagada         | dos funciones                                            | Sin ella, crear una invitación responde `AXEDA_FEATURE_DISABLED` (501)                                 |
| `publicIdentity`               | `boolean`                                    | `false`         | `true` / `false`                                         | Publica `GET /axeda/public/identity`, el único endpoint que no necesita sesión                         |
| `maxSessionAge`                | entero positivo (segundos) o `false`         | 30 días         | `> 0`, o `false` para apagarlo                           | Lo máximo que vive una sesión desde que se abrió, por mucho que se use. Se comprueba en `axeda({ … })` |
| `clock`                        | `{ now(): Date }`                            | el del sistema  | —                                                        | Solo para pruebas                                                                                      |

Las claves mal escritas **dentro** de `retention`, `invitations`, `limits` o la definición de una función se
rechazan. Una clave mal escrita en el **primer nivel** se ignora (mira
[la tabla de arriba](#cuándo-aparece-un-error)).

### Claves de permiso

Un permiso es `recurso:acción` (`invoice:create`) o `recurso:subrecurso:acción` (`report:sales:read`).

- 2 o 3 segmentos separados por `:`.
- Cada segmento: letras minúsculas, dígitos, `_` o `-`; empieza por una letra; como máximo 32 caracteres.
- El catálogo (`permissions`) lleva claves concretas: **sin comodines**, sin duplicados y nada que empiece
  por `axeda:` (reservado para los permisos propios de Axeda).
- En una función (no en el catálogo) el último segmento puede ser `*` (`invoice:*`), y `*` solo lo concede
  todo.

### Funciones declaradas en código

`roles` asocia una clave con una lista de permisos, o con una definición:

```ts
roles: {
  viewer: ['invoice:read'],
  cashier: { name: 'Cashier', description: 'Takes payments', permissions: ['invoice:*'], requireMfa: true },
}
```

| Campo         | Por omisión | Valores aceptados                                                                                                                                                                                |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| clave         | —           | Minúsculas, empieza por una letra; letras, dígitos, `_` y `-`; como máximo 64 caracteres                                                                                                         |
| `permissions` | —           | Al menos uno; como máximo `limits.maxPermissionsPerRole`. Aquí se admiten comodines (`invoice:*`, `*`), pero cada entrada debe cubrir algo del catálogo, así que un error tipográfico se detecta |
| `name`        | la clave    | De 1 a 200 caracteres                                                                                                                                                                            |
| `description` | ninguna     | Hasta 1000 caracteres                                                                                                                                                                            |
| `requireMfa`  | `false`     | La función no concede nada a un usuario sin autenticación en dos pasos. Necesita el plugin `twoFactor` de Better Auth                                                                            |

Las funciones declaradas aquí son **gestionadas**: `start()` las crea y las mantiene sincronizadas con tu
código, y la API se niega a editarlas (`AXEDA_ROLE_MANAGED`). Las funciones creadas por la API las cambias tú.

### Entregar las invitaciones

```ts
invitationDelivery: {
  acceptUrl: (token) => `https://app.example.com/accept?token=${encodeURIComponent(token)}`,
  send: async ({ email, link }) => mailer.send({ to: email, subject: 'You are invited', link }),
},
```

- Construye `acceptUrl` a partir de **tu URL base configurada**, nunca de la cabecera `Host` de una petición.
- `send` recibe datos, no HTML: escapa lo que pongas en un mensaje. Si lanza un error, quien llama recibe
  `AXEDA_DELIVERY_FAILED` (502).

### Vida de la sesión

Se aplican dos límites, y gana el más corto:

- `session.expiresIn` de Better Auth (7 días con el preset) es el tiempo **sin uso**: se renueva mientras la
  sesión se usa.
- `maxSessionAge` (30 días por omisión) es el tiempo **absoluto** desde que se inició sesión. Pasado ese
  tiempo, el usuario inicia sesión de nuevo, por reciente que fuera su actividad.

Mientras el límite la retiene, Better Auth escribe la fila de la sesión en cada petición durante el último
tramo de su vida (`expiresIn` menos `updateAge`: 6 días con el preset), en vez de una vez al día.

---

## 3. Express: `createAxedaExpress`

```ts
const x = createAxedaExpress({
  axeda: axedaPlugin.instance(),
  principal: sessionPrincipal(auth),
  trustedOrigins: ['https://app.example.com'],
  onDenied: (event) => logger.warn(event, 'request denied'),
});
```

| Opción           | Tipo                                 | Obligatoria    | Qué hace                                                                                                                                    |
| ---------------- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `axeda`          | `Axeda`                              | sí             | `axedaPlugin.instance()`; disponible tras crear Better Auth                                                                                 |
| `principal`      | `({ headers }) => Principal \| null` | sí             | Quién llama. Con Better Auth, `sessionPrincipal(auth)`. Nunca lo construyas con datos de la petición                                        |
| `trustedOrigins` | `string[]`                           | una de las dos | Orígenes que pueden enviar una escritura con cookie (defensa contra CSRF). Usa los front ends de tu app                                     |
| `csrf`           | `false`                              | una de las dos | Solo si esta API nunca se autentica con cookies                                                                                             |
| `onDenied`       | `(event) => void \| Promise<void>`   | no             | Se llama tras cada denegación para que la registres. No puede cambiar la respuesta, y un error dentro se ignora. Axeda no escribe registros |

Debes elegir entre `trustedOrigins` y `csrf: false`; los tipos no admiten ni las dos ni ninguna.

Cada ruta protegida usa `x.requirePermission(permission, { scope, onDeny })`:

| Opción   | Por omisión   | Qué hace                                                                                                                             |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `scope`  | global        | Dónde se comprueba el permiso, a partir de la petición (`resolveScope({ company: 'companyId' })`). Mira [Proteger rutas](express.md) |
| `onDeny` | `'forbidden'` | `'forbidden'` responde 403; `'not-found'` responde 404, igual si el recurso no existe o simplemente no es tuyo                       |

---

## Puesta en marcha, en orden

1. **Crea las opciones.** `secureAuthOptions({ … })` y `axeda({ … })` lanzan error con una entrada incorrecta.
2. **Migra la base de datos.** En bases SQL ejecuta la migración de Better Auth, que crea las tablas y los
   índices de Axeda:
   ```ts
   await (await getMigrations(options)).runMigrations();
   ```
   MongoDB no tiene migraciones: el adaptador crea las colecciones y los índices al usarlos.
   En una base SQL grande que ya existe, crear un índice nuevo puede bloquear las escrituras de esa tabla
   mientras se construye: elige un momento tranquilo.
3. **Crea Better Auth:** `const auth = betterAuth(options); await auth.$context;`. Esto valida las opciones
   del plugin y las cuatro opciones rechazadas.
4. **`await axedaPlugin.start()`.** Comprueba que la base de datos tiene transacciones de verdad y crea o
   actualiza tus funciones gestionadas. Llámalo al arrancar para que un problema detenga el proceso en vez de
   la primera petición. Se puede llamar más de una vez. Una caída breve de la base de datos se reintenta en
   la siguiente llamada; `AXEDA_INVALID_CONFIG` y `AXEDA_TRANSACTIONS_UNSUPPORTED` son permanentes y no.
5. **Crea el primer administrador**, una vez, desde un script del servidor (no es un endpoint, así que no
   hay contraseña que proteger):
   ```ts
   await axedaPlugin.instance().bootstrap({ userId });
   ```
   Se niega con `AXEDA_ALREADY_BOOTSTRAPPED` mientras exista un administrador global. Si desaparece el
   último, vuelve a funcionar, y esa es la vía de recuperación.
6. **Monta** el manejador de Better Auth **antes** de `express.json()`, y después tus rutas protegidas.

## Ajustes según la base de datos

| Base de datos | Lo que debes poner                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite        | Nada                                                                                                                                                                                              |
| PostgreSQL    | Un `pg.Pool`                                                                                                                                                                                      |
| MySQL         | El grupo de `mysql2/promise`, con `timezone: 'Z'`; `advanced.database.validateSchema: false` si el servidor guarda los nombres de tabla en minúsculas; acotar `audit.action` en una tabla antigua |
| MongoDB       | `mongodbAdapter(db, { client })` sobre un **conjunto de réplicas** (basta un nodo)                                                                                                                |

Los motivos y los pasos exactos están en [Bases de datos](reference.md#bases-de-datos).

## Variables de entorno

La librería no lee ninguna. Una aplicación típica las lee al arrancar, **falla si falta alguna** y pasa los
valores. La aplicación de ejemplo (`apps/example`) lo hace así y es un buen modelo:

| Variable                | Se pasa como     | Notas                                                                           |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `BASE_URL`              | `baseURL`        | URL pública del servidor. Sin valor por omisión                                 |
| `BETTER_AUTH_SECRET`    | `secret`         | Al menos 32 caracteres aleatorios. Sin valor por omisión. Fuera del repositorio |
| `TRUSTED_ORIGINS`       | `trustedOrigins` | Separados por comas. El ejemplo usa `BASE_URL` si está vacía                    |
| `TRUSTED_PROXIES`       | `trustedProxies` | IP o rangos CIDR separados por comas                                            |
| `NODE_ENV`              | `environment`    | `production` o `development`                                                    |
| `PORT`, `DATABASE_FILE` | —                | Propias del ejemplo (puerto de escucha y archivo SQLite)                        |

Las variables `AXEDA_TEST_*` son de la suite de pruebas y del benchmark, no de tu aplicación.

## Lista de comprobación para producción

- [ ] `baseURL` y cada entrada de `trustedOrigins` usan `https`, sin comodines.
- [ ] `secret` es aleatorio, de al menos 32 caracteres, y vive en un gestor de secretos, no en el repositorio.
- [ ] `environment` es `production` (lo normal).
- [ ] Detrás de un proxy: `trustedProxies` lo lista.
- [ ] Más de una instancia: `rateLimitStorage: 'database'`.
- [ ] `emailVerification.sendVerificationEmail` envía correo de verdad.
- [ ] `invitationDelivery.acceptUrl` se construye con tu URL configurada, no con `Host`.
- [ ] La migración se ejecutó y `start()` se ejecuta al arrancar.
- [ ] Las funciones con `requireMfa` tienen instalado el plugin `twoFactor` de Better Auth.
- [ ] `maxSessionAge` coincide con tu política (30 días por omisión).
- [ ] El primer administrador se creó con `bootstrap`.
- [ ] Archivas tú la auditoría: la retención no es automática y la tabla solo crece.
- [ ] MongoDB funciona como conjunto de réplicas; las tablas MySQL creadas antes del índice de `action` se acotaron.

## Problemas frecuentes

| Ves                                                                     | Causa y solución                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AXEDA_INVALID_CONFIG … Unrecognized key`                               | Una clave mal escrita dentro de `retention`, `invitations`, `limits` o una función. El mensaje da la ruta                       |
| `AXEDA_INVALID_CONFIG … Too big: expected number to be <=…`             | Un número por encima de su rango. Mira la [tabla de opciones](#opciones)                                                        |
| `AXEDA_INVALID_CONFIG … permission "…" …`                               | Una clave del catálogo mal formada, con comodín, duplicada o con prefijo `axeda:`; mira [Claves de permiso](#claves-de-permiso) |
| `AXEDA_INVALID_CONFIG … role "…" uses "…", which matches no permission` | Una función lista un permiso que tu catálogo no cubre. Normalmente un error tipográfico                                         |
| `AXEDA_INVALID_CONFIG … The secret …`                                   | `secret` tiene menos de 32 caracteres o es demasiado repetitivo                                                                 |
| `AXEDA_INVALID_CONFIG … must use https`                                 | Una URL es `http` en producción. Usa `https`, o `environment: 'development'` en `localhost`                                     |
| `AXEDA_INVALID_CONFIG … requireEmailVerification: false …`              | `false` solo sirve en desarrollo                                                                                                |
| `AXEDA_INVALID_CONFIG … Axeda cannot run with …`                        | Una de las [cuatro opciones rechazadas](#opciones-con-las-que-axeda-no-funciona). Quítala                                       |
| `no such table: axedaState` (u otra tabla de Axeda)                     | La migración no se ejecutó en esta base de datos                                                                                |
| `AXEDA_TRANSACTIONS_UNSUPPORTED`                                        | Sin transacciones reales: en MongoDB usa un conjunto de réplicas y pasa `client`; en SQL, una base que Better Auth soporte      |
| Crear una invitación responde `AXEDA_FEATURE_DISABLED`                  | `invitationDelivery` no está configurada. Revisa también su ortografía                                                          |
| `GET /axeda/public/identity` responde 404                               | `publicIdentity` es `false` (lo normal)                                                                                         |
| `429` al iniciar sesión o registrarse                                   | Los límites de peticiones del preset. Espera, o súbelos sobrescribiendo `rateLimit` después del spread                          |
