# Referencia

## Opciones del plugin (`axeda({ … })`)

| Opción                         | Tipo                                                                           | Por omisión | Significado                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------- |
| `permissions`                  | `string[]`                                                                     | —           | Tu catálogo de permisos (concretos, sin comodines). **Obligatoria** |
| `roles`                        | `Record<clave, string[] \| { name?, description?, permissions, requireMfa? }>` | `{}`        | Funciones declaradas, sincronizadas al arrancar                     |
| `menus`                        | `MenuDefinition[]`                                                             | `[]`        | El menú, declarado en el código                                     |
| `retention.graceDays`          | `number` (0–3650)                                                              | `30`        | Días que una compañía o negocio borrado puede restaurarse           |
| `invitations.ttlHours`         | `number`                                                                       | `72`        | Vigencia por defecto de una invitación                              |
| `invitations.maxRoles`         | `number` (1–50)                                                                | `10`        | Funciones por invitación                                            |
| `limits.maxAssignmentsPerUser` | `number`                                                                       | `50`        | Asignaciones que puede tener un usuario                             |
| `limits.maxPermissionsPerRole` | `number`                                                                       | `100`       | Permisos en una función                                             |
| `limits.maxCachedUsers`        | `number`                                                                       | `10000`     | Usuarios cuyos permisos guarda en caché cada proceso                |
| `invitationDelivery`           | `{ acceptUrl(token), send(message) }`                                          | apagado     | Cómo se entregan las invitaciones. Sin esto están desactivadas      |
| `publicIdentity`               | `boolean`                                                                      | `false`     | Expone `GET /axeda/public/identity` (el único endpoint sin sesión)  |
| `maxSessionAge`                | `number` (segundos) o `false`                                                  | 30 días     | Lo máximo que vive una sesión desde el inicio, por mucho que se use |

`acceptUrl` debe construirse con tu URL base configurada, nunca con la cabecera `Host` de una petición.

### Elementos del menú

| Campo           | Notas                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| `key`           | Única                                                                      |
| `parent`        | Clave de un grupo que exista                                               |
| `label`         | Un texto, o uno por idioma: `{ en: 'Invoices', es: 'Facturas' }`           |
| `path`          | Solo en las hojas. Empieza por `/`, sin esquema, sin `//`, sin espacios    |
| `requires`      | Solo en las hojas, **obligatorio**. Un permiso concreto del catálogo       |
| `actions`       | Permisos de los botones de esa pantalla; el menú informa `can` de cada uno |
| `icon`, `order` | Presentación                                                               |

Máximo 200 elementos y 3 niveles. La etiqueta se elige por idioma exacto, luego idioma base
(`es-MX` → `es`), luego `en`, luego la etiqueta sin idioma y por último la primera disponible.

## Endpoints

Todos cuelgan de la ruta base de Better Auth (`/api/auth`). Todos exigen sesión salvo el último.
«Por objetivo» significa que el permiso se comprueba en el alcance de lo que se modifica.

| Método | Ruta                          | Requiere                                              | Se comprueba en      |
| ------ | ----------------------------- | ----------------------------------------------------- | -------------------- |
| GET    | `/axeda/me`                   | (sesión)                                              | propio               |
| GET    | `/axeda/permission/list`      | `axeda:role:manage` o `axeda:assignment:manage`       | cualquiera           |
| GET    | `/axeda/role/list`            | `axeda:role:manage` o `axeda:assignment:manage`       | cualquiera           |
| GET    | `/axeda/role/get`             | `axeda:role:manage` o `axeda:assignment:manage`       | cualquiera           |
| POST   | `/axeda/role/create`          | `axeda:role:manage`                                   | global               |
| POST   | `/axeda/role/update`          | `axeda:role:manage`                                   | global               |
| POST   | `/axeda/role/set-status`      | `axeda:role:manage`                                   | global               |
| POST   | `/axeda/role/delete`          | `axeda:role:manage`                                   | global               |
| GET    | `/axeda/assignment/list`      | `axeda:assignment:manage`                             | por objetivo         |
| POST   | `/axeda/assignment/create`    | `axeda:assignment:manage`                             | parámetro de alcance |
| POST   | `/axeda/assignment/revoke`    | `axeda:assignment:manage`                             | por objetivo         |
| GET    | `/axeda/audit/list`           | `axeda:audit:read`                                    | parámetro de alcance |
| GET    | `/axeda/company/list`         | pertenencia                                           | por objetivo         |
| GET    | `/axeda/company/get`          | pertenencia                                           | por objetivo         |
| POST   | `/axeda/company/create`       | `axeda:company:manage`                                | global               |
| POST   | `/axeda/company/update`       | `axeda:company:manage`                                | por objetivo         |
| POST   | `/axeda/company/set-status`   | `axeda:company:manage`                                | global               |
| POST   | `/axeda/company/delete`       | `axeda:company:manage`                                | global               |
| POST   | `/axeda/company/restore`      | `axeda:company:manage`                                | global               |
| GET    | `/axeda/business/list`        | pertenencia                                           | por objetivo         |
| GET    | `/axeda/business/get`         | pertenencia                                           | por objetivo         |
| POST   | `/axeda/business/create`      | `axeda:business:manage`                               | por objetivo         |
| POST   | `/axeda/business/update`      | `axeda:business:manage`                               | por objetivo         |
| POST   | `/axeda/business/set-status`  | `axeda:business:manage`                               | por objetivo         |
| POST   | `/axeda/business/delete`      | `axeda:business:manage`                               | por objetivo         |
| POST   | `/axeda/business/restore`     | `axeda:business:manage`                               | por objetivo         |
| GET    | `/axeda/invitation/list`      | `axeda:invitation:manage`                             | parámetro de alcance |
| POST   | `/axeda/invitation/create`    | `axeda:invitation:manage`                             | parámetro de alcance |
| POST   | `/axeda/invitation/accept`    | (sesión; autorizan el secreto y un correo verificado) | propio               |
| POST   | `/axeda/invitation/revoke`    | `axeda:invitation:manage`                             | por objetivo         |
| GET    | `/axeda/user/list`            | `axeda:user:manage`                                   | global               |
| POST   | `/axeda/user/create`          | `axeda:user:manage`                                   | global               |
| POST   | `/axeda/user/ban`             | `axeda:user:manage`                                   | global               |
| POST   | `/axeda/user/unban`           | `axeda:user:manage`                                   | global               |
| POST   | `/axeda/user/revoke-sessions` | `axeda:user:manage`                                   | global               |
| GET    | `/axeda/menu`                 | (sesión; solo lista lo que puedes usar)               | propio               |
| GET    | `/axeda/public/identity`      | (pública, apagada salvo `publicIdentity`)             | —                    |

Los endpoints de Better Auth solo admiten `GET` y `POST`, por eso las modificaciones y los borrados
son `POST`. Los endpoints de Axeda tienen límite de peticiones por dirección: 120 por minuto, y 30
para `/axeda/public/`. El cliente tipado lo refleja: `client.axeda.role.create({ … })`,
`client.axeda.menu({ query })`.

## Códigos de error

Los errores tienen la forma `{ code, message }`. Los códigos son estables; los mensajes están en
inglés y pueden cambiar, así que decide por `code`.

| Código                       | Estado | Significado                                                                 |
| ---------------------------- | ------ | --------------------------------------------------------------------------- |
| `AXEDA_INVALID_INPUT`        | 400    | La entrada no pasó la validación                                            |
| `AXEDA_INVALID_PERMISSION`   | 400    | No es un permiso bien formado                                               |
| `AXEDA_UNKNOWN_PERMISSION`   | 400    | Un permiso que no está en el catálogo                                       |
| `AXEDA_INVITATION_INVALID`   | 400    | Invitación incorrecta, caducada, usada o revocada, o el correo no coincide  |
| `AXEDA_FORBIDDEN`            | 403    | No tienes permiso para esto                                                 |
| `AXEDA_MFA_REQUIRED`         | 403    | La función exige un 2FA que el usuario no tiene activado                    |
| `AXEDA_USER_BANNED`          | 403    | La cuenta está suspendida (al iniciar sesión)                               |
| `AXEDA_ROLE_NOT_FOUND`       | 404    |                                                                             |
| `AXEDA_ASSIGNMENT_NOT_FOUND` | 404    |                                                                             |
| `AXEDA_USER_NOT_FOUND`       | 404    |                                                                             |
| `AXEDA_COMPANY_NOT_FOUND`    | 404    |                                                                             |
| `AXEDA_BUSINESS_NOT_FOUND`   | 404    |                                                                             |
| `AXEDA_EMAIL_TAKEN`          | 409    | Ya existe una cuenta con ese correo                                         |
| `AXEDA_ROLE_KEY_TAKEN`       | 409    |                                                                             |
| `AXEDA_ROLE_MANAGED`         | 409    | La función está declarada en el código y no se cambia aquí                  |
| `AXEDA_VERSION_CONFLICT`     | 409    | Alguien la cambió antes; recarga y reintenta                                |
| `AXEDA_ASSIGNMENT_EXISTS`    | 409    |                                                                             |
| `AXEDA_LIMIT_EXCEEDED`       | 409    | Se alcanzó un límite configurado                                            |
| `AXEDA_ALREADY_BOOTSTRAPPED` | 409    | Ya existe una administración global                                         |
| `AXEDA_SLUG_TAKEN`           | 409    |                                                                             |
| `AXEDA_INVITATION_EXISTS`    | 409    | Ya hay una invitación pendiente para ese correo y alcance                   |
| `AXEDA_FEATURE_DISABLED`     | 501    | Las invitaciones o la administración de usuarios no están configuradas      |
| `AXEDA_DELIVERY_FAILED`      | 502    | Tu `invitationDelivery.send` lanzó un error                                 |
| `AXEDA_INTERNAL_ERROR`       | 500    | Cualquier cosa inesperada; el detalle queda en los registros de tu servidor |

Los problemas de configuración (`AXEDA_INVALID_CONFIG`, `AXEDA_TRANSACTIONS_UNSUPPORTED`,
`AXEDA_DATA_CORRUPT`) nunca llegan al cliente como tales: aparecen como `AXEDA_INTERNAL_ERROR`.

`@teamblind/axeda-express` añade `AXEDA_UNAUTHENTICATED` (401), `AXEDA_FORBIDDEN` (403), `AXEDA_NOT_FOUND`
(404) y `AXEDA_CROSS_SITE` (403); consulta [Proteger rutas](express.md).

## `secureAuthOptions(input)`

| Entrada                    | Por omisión    | Notas                                                            |
| -------------------------- | -------------- | ---------------------------------------------------------------- |
| `baseURL`                  | —              | URL pública del servidor de autenticación; `https` en producción |
| `secret`                   | —              | Al menos 32 caracteres, no repetitivo                            |
| `trustedOrigins`           | —              | Al menos uno; solo orígenes, sin comodines                       |
| `environment`              | `'production'` | `'development'` admite `http://localhost`                        |
| `trustedProxies`           | ninguno        | IP o CIDR de tus proxies inversos                                |
| `rateLimitStorage`         | `'memory'`     | Usa `'database'` con varias instancias                           |
| `requireEmailVerification` | `true`         | `false` solo en desarrollo                                       |

Devuelve `baseURL`, `secret`, `trustedOrigins`, `emailAndPassword`, `session`, `advanced` y
`rateLimit` para esparcirlos en `betterAuth({ … })`. Si sobrescribes una de estas claves,
reemplazas la clave completa, así que copia lo que aún necesites.

## API de TypeScript

Obtén la instancia con `axedaPlugin.instance()` una vez creado Better Auth.

| Llamada                                                                   | Devuelve                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `can(principal, permission, target?)`                                     | `boolean`; global si no hay objetivo                                                                   |
| `canAnywhere(principal, permission)`                                      | ¿Lo tiene en algún alcance?                                                                            |
| `effectivePermissions(principal, target?)`                                | El conjunto de permisos que tiene ahí                                                                  |
| `scopesFor(principal, permission)`                                        | Los alcances donde lo tiene                                                                            |
| `scopeFilter(principal, permission)`                                      | `{ unrestricted, companyIds, businessIds }` para tus consultas                                         |
| `resolveTarget(scope)`                                                    | El objetivo comprobable de un id de compañía o negocio, leído de la base de datos; `null` si no existe |
| `menu(principal, { scope?, locale? })`                                    | El árbol de menú filtrado                                                                              |
| `roles`, `assignments`, `companies`, `businesses`, `invitations`, `users` | Las mismas operaciones que exponen los endpoints, recibiendo un `actor`                                |
| `publicIdentity({ company, business? })`                                  | Nombre y logos públicos de una compañía o negocio activo                                               |
| `listAudit(actor, filter, page)`                                          | Una página de eventos de auditoría                                                                     |
| `purgeDeleted()`                                                          | Elimina para siempre lo que pasó su periodo de gracia                                                  |
| `bootstrap({ userId })`                                                   | Crea la primera administración global (una vez)                                                        |

Un `Principal` es `{ userId, authzVersion?, twoFactorEnabled?, banned? }`. Constrúyelo siempre con
`sessionPrincipal(auth)` o `principalFromUser(row)` a partir de la fila de usuario que Better Auth
acaba de leer; nunca con datos de la petición.

## Bases de datos

Axeda guarda sus datos a través del adaptador de base de datos de Better Auth, así que funciona en
las bases de datos que Better Auth soporta **y que tienen transacciones reales**; lo comprueba al
arrancar y, si no, se niega.

| Base de datos | Lo que le das a Better Auth                              | Comprobado en el CI                     |
| ------------- | -------------------------------------------------------- | --------------------------------------- |
| SQLite        | `new Database(archivo)` de `better-sqlite3`              | En memoria                              |
| PostgreSQL    | `new pg.Pool({ connectionString })`                      | 16 y 18, servidores reales, grupo de 10 |
| MySQL         | `createPool({ uri, timezone: 'Z' })` de `mysql2/promise` | 8.4 y 9, servidores reales, grupo de 10 |

MongoDB aún no se soporta.

**MySQL.**

- Dale a Better Auth el grupo de `mysql2/promise`, no el de `mysql2`, y pon `timezone: 'Z'`. Sin
  eso el controlador convierte las fechas a la hora local de tu proceso, y un servidor en otra zona
  (o un cambio de horario) las desplaza.
- **Nombres de tabla.** Better Auth valida el esquema al arrancar y en las peticiones de
  autenticación, y compara los nombres de tabla distinguiendo mayúsculas. Un servidor que los
  guarda en minúsculas (`lower_case_table_names` 1 o 2: Windows, macOS y algunos servicios
  gestionados) hace que dé por faltantes las tablas de Axeda (`axedaRole`, `axedaAssignment`…), y las
  peticiones de autenticación fallan con «Database schema mismatch». O arrancas el servidor con
  `lower_case_table_names=0` (lo normal en Linux; solo se puede elegir al inicializar el servidor
  por primera vez), o apagas esa comprobación con
  `advanced: { database: { validateSchema: false } }`, que además deja de validar el resto de tu
  esquema. El CI cubre Linux; la segunda opción se comprobó contra un servidor Windows.
- Las columnas de texto usan la collation por omisión del servidor, que no distingue `A` de `a`.
  No cambia nada para Axeda: las claves de rol, los slugs y las claves de permiso son en minúsculas
  por validación.

## Rendimiento

Medido con `npm run bench` en un ejecutor de GitHub con Linux, con PostgreSQL 18 en la misma máquina y un grupo de 10 conexiones. Son las cifras de una sola corrida en una máquina compartida: léelas como un orden de magnitud, no como una promesa; ejecuta el benchmark contra tu propia base de datos para obtener las tuyas.

| Qué                                                                     | p50 (ms) | p95 (ms) | Consultas |
| ----------------------------------------------------------------------- | -------: | -------: | --------: |
| `can()`, caché caliente, versión del usuario ya conocida (sesión)       |     0.26 |     0.31 |         1 |
| `can()`, caché caliente, versión leída de la base de datos              |     0.56 |     0.91 |         2 |
| `can()`, caché fría (la primera vez de esa persona)                     |     1.54 |     1.81 |         5 |
| `can()` justo después de editar una función que todos tienen            |     1.63 |     2.12 |         5 |
| Una ruta: resolver la compañía y luego `can()`                          |     0.55 |     0.65 |         2 |
| Una ruta: resolver el negocio y su compañía y luego `can()`             |     0.82 |     1.08 |         3 |
| Página de 50 de la auditoría, 20 000 eventos, sin filtro                |     0.58 |     1.41 |         1 |
| Lo mismo, filtrada por una persona que escribió la mitad de los eventos |    10.51 |    11.34 |         1 |
| Conceder una función, una a la vez                                      |     5.29 |    74.21 |         — |
| Conceder una función, 16 a la vez                                       |    89.66 |   283.57 |         — |

Comprobar permisos es la operación frecuente y, con la caché caliente, cuesta una consulta barata. Editar una función no detiene a nadie: la siguiente comprobación de cada persona toma el camino frío (unos 2 ms). La administración es poco frecuente y más pesada a propósito: una concesión es una transacción que además escribe el registro de auditoría, y las concesiones de una misma persona se aplican de una en una (sus propios permisos no pueden cambiar mientras concede), así que una persona llega a unas 130 concesiones por segundo sin importar cuántas peticiones haya en curso.

La tabla de arriba es `can()` a solas. Una ruta que antes resuelve una compañía o un negocio en la base de datos (Axeda nunca se fía del identificador que envía la petición) paga además eso: **2 consultas** para una compañía y **3** para un negocio con la caché caliente y la sesión entregando la versión del usuario, una más si no la entrega. El benchmark las cuenta y falla si aumentan. También mide los listados paginados sobre una auditoría grande y un alcance grande, y cuántas veces escribe Better Auth la sesión por petición. A este tamaño, el único listado que destaca es la auditoría filtrada por una persona muy activa: unas 18 veces la página sin filtrar (10.51 ms frente a 0.58 ms, derivado de la tabla); la página sin filtrar y los listados por alcance se quedan cerca de 1 ms.
