# Actualizar

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
