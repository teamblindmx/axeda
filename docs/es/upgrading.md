# Actualizar

## De `0.1.0-alpha.3` a `0.1.0-alpha.4`

Las cuentas de personal son nuevas y solo se suman. Tienes que ejecutar la migración de la base de datos.

| Qué cambió                                                                             | ¿Tienes que hacer algo?                                                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cuentas de personal con usuario y PIN, y `axeda:staff:manage`                          | Solo si las quieres ([Configuración](configuration.md#cuentas-de-personal-usuario-y-pin))    |
| Una tabla nueva, `axedaStaff`                                                          | **Sí**: ejecuta la migración                                                                 |
| `AxedaPersistence` necesita un almacén `staff`; `UserAdmin` puede implementar `delete` | Solo si escribiste los tuyos ([abajo](#tu-propia-persistencia-y-administración-de-usuarios)) |
| Una lectura de permisos en frío hace una consulta más                                  | No: va en paralelo y solo cuando falla la caché                                              |

### Tu propia persistencia y administración de usuarios

Añade un almacén `staff` (`StaffStore`): usuarios únicos por compañía, intentos gastados de forma atómica
antes de comprobar el PIN, y borrar las cuentas de lo que se purga. `runPersistenceContract` lo comprueba.
El personal necesita además `UserAdmin.delete` y la dependencia `pinHasher` de `createAxeda` (el plugin de
Better Auth pone las dos).

## De `0.1.0-alpha.2` a `0.1.0-alpha.3`

Las imágenes son nuevas y solo se suman: nada de lo que ya usas cambia su comportamiento. Tienes que
ejecutar la migración de la base de datos.

| Qué cambió                                                          | ¿Tienes que hacer algo?                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Logos, favicons y fotos de perfil, subidos directo a R2, S3 o MinIO | Solo si los quieres ([Configuración](configuration.md#imágenes-logos-favicons-y-fotos-de-perfil)) |
| Una tabla nueva, `axedaImage`                                       | **Sí**: ejecuta la migración                                                                      |
| Un paquete nuevo, `@teamblind/axeda-storage`                        | Solo para las imágenes                                                                            |
| `AxedaPersistence` necesita un almacén `images`                     | Solo si escribiste tu propia persistencia ([abajo](#tu-propia-persistencia-y-almacén))            |
| Los usuarios llevan `image`, y `purgeDeleted()` devuelve `images`   | Solo si tu código compara esos objetos campo a campo                                              |

### Tu propia persistencia y almacén

Añade un almacén `images` (`ImageStore`): una sola imagen lista por propósito y entidad, completar una
subida una sola vez, y borrar las imágenes de lo que se purga. `runPersistenceContract` lo comprueba. Un
`UserAdmin` propio devuelve `image` en cada `ManagedUser` y puede implementar `setImage`; sin él no hay
fotos de perfil. Un `ObjectStorage` propio se comprueba con `runObjectStorageContract`.

## De `0.1.0-alpha.1` a `0.1.0-alpha.2`

Nada de lo que ya usas cambia su comportamiento: las sedes y el acceso por teléfono son nuevos y solo se
suman. Tienes que ejecutar la migración de la base de datos, y hay algunos casos que conviene revisar.

| Qué cambió                                                                                             | ¿Tienes que hacer algo?                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Las sedes, un alcance nuevo bajo la compañía                                                           | Solo si las quieres usar ([abajo](#sedes))                                                                        |
| El acceso por teléfono, y las invitaciones por teléfono                                                | Solo si los quieres usar ([abajo](#acceso-por-teléfono))                                                          |
| Tablas nuevas `axedaSite` y `axedaThrottle`, y una columna nueva `channel` en `axedaInvitation`        | **Sí**: ejecuta la migración ([abajo](#la-migración))                                                             |
| Las invitaciones y los usuarios tienen campos nuevos (`channel`, `phoneNumber`, `phoneNumberVerified`) | Solo si tu código compara esos objetos campo a campo, o implementa `UserAdmin` ([abajo](#tu-propia-persistencia)) |
| `invitationDelivery.send` recibe `channel` y `phoneNumber`                                             | No, salvo que envíes invitaciones por teléfono                                                                    |
| `AxedaPersistence` necesita un almacén `sites`                                                         | Solo si escribiste tu propia persistencia ([abajo](#tu-propia-persistencia))                                      |
| `scopeFilter` devuelve `siteIds` y `purgeDeleted()` devuelve `sites`                                   | Solo si tu código compara esos objetos campo a campo                                                              |
| `GET /axeda/me` acepta un lugar opcional y entonces devuelve `permissions`                             | No; mira la [Referencia](reference.md#endpoints)                                                                  |

### Sedes

Una sede es un lugar de una compañía. Pertenece siempre a una compañía y, opcionalmente, a uno de sus
negocios, así que una compañía puede tener sedes sin negocios. Una función asignada en la compañía
vale en todas sus sedes, una en un negocio en las sedes de ese negocio, y una en una sede solo allí.
Los empleados de una sede son las personas con una función asignada en ella. Las sedes se
administran con el permiso nuevo `axeda:site:manage`, desde la compañía o desde el negocio del que
cuelgan.

```ts
// Una sede directamente de la compañía, y otra de un negocio de esa compañía
await axeda.sites.create(actor, companyId, { slug: 'hq', name: 'Headquarters' });
await axeda.sites.create(actor, companyId, { slug: 'north', name: 'North', businessId });

// Un empleado: una función asignada en la sede
await axeda.assignments.assign(actor, { userId, roleId, scope: { type: 'site', id: siteId } });

// Una ruta de Express de una sede; su compañía y su negocio salen de la base de datos
app.get(
  '/companies/:companyId/sites/:siteId/invoices',
  x.requirePermission('invoice:read', {
    scope: resolveScope({ company: 'companyId', site: 'siteId' }),
  }),
  listInvoices,
);
```

### Acceso por teléfono

Las personas pueden registrarse e iniciar sesión con un número de teléfono y un código, y puedes
invitarlas por su número. Añade el plugin `phoneNumber` de Better Auth con `securePhoneNumberOptions`, y
envía las invitaciones por teléfono desde `invitationDelivery.send` cuando `channel` sea `phone`. Mira
[Configuración](configuration.md#acceso-por-teléfono-securephonenumberoptions).

```ts
await axeda.invitations.create(actor, {
  phoneNumber: '+5215512345678',
  scope: { type: 'site', id: siteId },
  roleIds: [cashierRoleId],
});
```

El plugin de teléfono añade `phoneNumber` y `phoneNumberVerified` a la tabla `user` de Better Auth;
ejecuta su migración después de añadirlo.

### La migración

Ejecuta la migración de Better Auth como siempre. Crea las tablas `axedaSite` y `axedaThrottle` y añade
la columna opcional `channel` a `axedaInvitation`; las invitaciones que ya existen siguen funcionando
como invitaciones por correo. MongoDB no tiene migraciones: las colecciones se crean al usarlas.

### Tu propia persistencia

Si implementaste `AxedaPersistence` por tu cuenta, añade un almacén `sites` (`SiteStore`) y haz que
purgar una compañía o un negocio purgue también sus sedes, con sus asignaciones e invitaciones. Las
invitaciones tienen ahora un `channel`: guarda `phoneNumber` en las de teléfono, y busca en
`findPending` por el contacto (el correo, o el número en una por teléfono; `invitationContact` lo da).
`runPersistenceContract` de `@teamblind/axeda-testing` lo comprueba todo.

Si implementaste `UserAdmin`, devuelve `phoneNumber` (o `null`) y `phoneNumberVerified` en cada
`ManagedUser`. Un `UserDirectory` también puede devolverlos; sin ellos no se puede aceptar ninguna
invitación por teléfono.

## De `0.1.0-alpha.0` a `0.1.0-alpha.1`

No se quitó ni se renombró ninguna función, tipo u opción exportada: lo único que crece en la API es la
opción `maxSessionAge`. No tienes que cambiar tu código. **Sí** tienes que ejecutar la migración de la base
de datos, y un valor por omisión cambia cuánto viven las sesiones.

| Qué cambió                                              | ¿Tienes que hacer algo?                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Las sesiones terminan 30 días después de iniciar sesión | Decide: dejarlo, cambiarlo o apagarlo ([abajo](#1-las-sesiones-tienen-ahora-una-duración-absoluta)) |
| Índices nuevos en las tablas de Axeda                   | **Sí**: ejecuta la migración ([abajo](#2-ejecuta-la-migración))                                     |
| Tablas MySQL creadas por una versión de desarrollo      | Solo entonces: un `ALTER` antes ([abajo](#3-solo-mysql-una-tabla-existente))                        |
| Los ids de los eventos de auditoría son más cortos      | No ([abajo](#4-ids-de-los-eventos-de-auditoría))                                                    |
| Se soportan MySQL y MongoDB                             | No; mira [Configuración](configuration.md#ajustes-según-la-base-de-datos)                           |

### Instalar

Los cuatro paquetes se publican juntos, con la misma versión:

```bash
npm install @teamblind/axeda-core@alpha @teamblind/axeda-better-auth@alpha @teamblind/axeda-express@alpha
npm install --save-dev @teamblind/axeda-testing@alpha
```

### 1. Las sesiones tienen ahora una duración absoluta

Better Auth renueva una sesión cada vez que se usa, así que una sesión de uso diario nunca terminaba. Axeda
ahora la limita: una sesión nunca vive más allá de su creación más `maxSessionAge`, **30 días por
omisión**. Las sesiones que ya son más antiguas se cortan la próxima vez que Better Auth las renueva, y la
persona inicia sesión de nuevo.

```ts
axeda({ permissions, maxSessionAge: 60 * 60 * 24 * 90 }); // 90 días
axeda({ permissions, maxSessionAge: false }); // el comportamiento anterior: sin límite absoluto
```

Mientras el límite la retiene, Better Auth escribe la fila de la sesión en cada petición durante el último
tramo de su vida (`expiresIn` menos `updateAge`: 6 días con el preset), en vez de una vez al día. Mira
[Vida de la sesión](configuration.md#vida-de-la-sesión).

### 2. Ejecuta la migración

Ejecuta la migración de Better Auth como cuando instalaste Axeda:

```ts
await (await getMigrations(options)).runMigrations();
```

Añade cinco índices y conserva todas las filas:

- Un índice único sobre la clave del rol, el slug de la compañía, la clave del estado de política y la
  clave de la invitación pendiente. Antes eran una columna `unique`; la restricción de la columna se queda,
  así que cada una de esas tablas acaba con las dos (cuatro índices pequeños y redundantes). Los duplicados
  se siguen rechazando.
- Un índice sobre la columna `action` de la auditoría. Listar la auditoría por acción leía toda la tabla;
  con 200 000 eventos tardaba de 51 a 74 ms en PostgreSQL 16 y 18, y con el índice tarda una fracción de
  milisegundo.

Ejecutarla dos veces es seguro. En una base SQL grande que ya existe, crear un índice puede bloquear las
escrituras de esa tabla mientras se construye, así que elige un momento tranquilo. Después,
`await axedaPlugin.start()` debe funcionar como antes.

MongoDB no tiene migraciones: el adaptador crea los índices la primera vez que usa cada colección.

### 3. Solo MySQL: una tabla existente

Better Auth crea como `text` las columnas de texto sin índice, y en MySQL no indexa una columna `text` que
ya existe. Si la tabla de auditoría ya existe en MySQL, acota la columna una vez **antes** de la migración:

```sql
ALTER TABLE axedaAudit MODIFY action varchar(255) NOT NULL;
```

Si no, la migración se detiene con `can exceed MySQL's 3072-byte index-key limit`. `0.1.0-alpha.0` no
soportaba MySQL, así que esto afecta solo a tablas creadas por una versión de desarrollo. Una base MySQL
nueva no se ve afectada.

### 4. Ids de los eventos de auditoría

Los eventos nuevos llevan ids de 36 caracteres en vez de 50, para que quepan en la columna `varchar(36)` que
Better Auth crea en MySQL. Los eventos ya guardados conservan su id y su lugar en el orden, y los ids se
siguen ordenando por tiempo. Trata el id como opaco: no lo interpretes.
