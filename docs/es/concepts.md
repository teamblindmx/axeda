# Conceptos

## La jerarquía

Axeda decide en tres niveles. Un permiso siempre se comprueba **en un alcance**:

```
global                         toda la plataforma
 └─ compañía  (acme)           el límite de aislamiento entre clientes
     └─ negocio  (tienda-1)    una sucursal, tienda o unidad dentro de una compañía
```

Una función asignada en un nivel **se aplica hacia abajo**: la global cubre todas las compañías y
negocios; la de una compañía cubre sus negocios; la de un negocio cubre solo ese negocio. Nada se
aplica hacia arriba ni hacia los lados: una función en una compañía no dice nada de otra.

La **compañía es el límite de aislamiento**. Un negocio pertenece siempre a una compañía, fijada
al crearlo. Cuando una petición nombra un negocio, Axeda lee su compañía de la base de datos y
nunca de la petición.

## Permisos

Un permiso es `recurso:acción` (`invoice:read`); los propios de Axeda se ven así: `axeda:role:manage`.

- **Los declaras en el código** (`axeda({ permissions: [...] })`). La lista es el catálogo.
- Una **comprobación** (`can`, `requirePermission`) necesita un permiso concreto del catálogo. Un
  error tipográfico es un error al arrancar, nunca un «no» silencioso.
- Una **función** puede llevar comodines en el último segmento: `invoice:*` (toda acción sobre
  facturas) o `*` (todo).
- Los permisos propios de Axeda solo valen en algunos niveles (por ejemplo `axeda:role:manage` es
  solo global). Por eso una función con `*` solo puede asignarse en global.

| Permiso de Axeda          | Niveles                   | Permite                                        |
| ------------------------- | ------------------------- | ---------------------------------------------- |
| `axeda:role:manage`       | global                    | Crear, editar, desactivar y borrar funciones   |
| `axeda:assignment:manage` | global, compañía, negocio | Conceder y revocar funciones en un alcance     |
| `axeda:company:manage`    | global, compañía          | Administrar compañías                          |
| `axeda:business:manage`   | global, compañía          | Administrar negocios                           |
| `axeda:invitation:manage` | global, compañía, negocio | Invitar personas                               |
| `axeda:user:manage`       | global                    | Listar, crear, bloquear y desbloquear usuarios |
| `axeda:audit:read`        | global, compañía          | Leer la auditoría                              |

## Funciones y asignaciones

Una **función** (_role_ en inglés) es un conjunto de permisos con nombre. Las funciones son
globales: la misma «Cajera» puede asignarse en cualquier alcance. Hay dos tipos:

- Las **funciones declaradas** viven en el código (`roles: { cashier: {...} }`). Se sincronizan al
  arrancar y no se editan por la API (`AXEDA_ROLE_MANAGED`).
- Las **funciones creadas** se hacen por la API, por quien tenga `axeda:role:manage`.

Una función puede exigir autenticación en dos pasos (`requireMfa`). No concede nada a quien no
tenga el 2FA activado, y no puede asignarse a esa persona.

Una **asignación** une un usuario, una función y un alcance, con fecha de caducidad opcional. Un
usuario puede tener varias. Sus permisos efectivos en un lugar son la unión de todas las
asignaciones que aplican ahí y siguen vigentes.

### Nadie puede subir a otra persona por encima de su propio nivel

Es la regla en la que descansa todo el diseño, y se comprueba en el servidor en cada operación:

- **Conceder** exige `axeda:assignment:manage` _en el alcance de destino_, y cada permiso de la
  función debe estar cubierto por lo que quien concede ya tiene ahí. Quien administra la compañía
  A no puede conceder en la B ni en global.
- **Revocar** tiene el mismo requisito, así que un administrador menor no puede quitarle el acceso
  a uno mayor.
- **Editar una función** no puede añadir permisos que quien edita no tiene en global. Sin esto,
  quien gestiona funciones podría añadir `*` a la suya. Reactivar una función o quitarle
  `requireMfa` devuelve sus permisos a quienes la tienen, así que ambas cosas exigen que quien
  edita los cubra todos.
- **Actuar sobre un usuario** (bloquear, cerrar sus sesiones) exige `axeda:user:manage` y poder
  administrativo suficiente para cubrir el del objetivo. El soporte no puede bloquear a la
  administración global, y nadie puede bloquearse a sí mismo.

Una prueba de propiedades lanza secuencias aleatorias de operaciones a la API y comprueba que
nadie termina por encima del techo inicial.

## Denegación: 403 frente a 404

Axeda deniega por defecto. Cuando se rechaza una petición:

- **403** si puedes ver la cosa pero no puedes hacer esto.
- **404** si no se te permitiría saber que existe (una compañía a la que no perteneces).

El permiso se comprueba **antes** de validar la entrada o revelar nada, así que la falta de
permiso da la misma respuesta con un id real que con uno inventado.

## Compañías y negocios

Ambos están `active` o `inactive`, y pueden **borrarse de forma lógica**. Al borrar se conserva el
registro durante un periodo de gracia (30 días por omisión, `retention.graceDays`) en el que se
puede restaurar; `purgeDeleted()` elimina para siempre lo vencido (lo llamas tú, por ejemplo desde
un cron: Axeda no ejecuta nada en segundo plano). Una compañía inactiva o borrada, y todo lo que
contiene, **no concede nada**: las asignaciones ahí dejan de contar. Un negocio hereda el estado
de su compañía.

## Invitaciones

Una invitación nombra un correo, un alcance y las funciones a conceder. Axeda genera un secreto
(256 bits; solo se guarda su huella) y se lo entrega a **tu** función de envío. La persona acepta
con ese secreto **y un correo verificado que coincida**, así que un enlace filtrado por sí solo no
sirve. Las invitaciones caducan, pueden revocarse y son de un solo uso.

## Usuarios

Axeda **no** maneja contraseñas. `user/create` crea una cuenta **sin ninguna credencial** y nunca
marca el correo como verificado; la persona establece su contraseña por el flujo normal de Better
Auth. Un **bloqueo** (opcionalmente hasta una fecha):

1. impide abrir sesiones nuevas,
2. cierra las abiertas,
3. deja al usuario sin ningún permiso, incluso por una vía que nunca abre sesión, como una llave
   de API.

Un bloqueo temporal se levanta solo al llegar su fecha; no hace falta ninguna tarea.

## Menús

Declaras el menú en el código. Toda entrada con ruta debe decir qué permiso requiere; un grupo no
tiene ninguno y se muestra solo si algún hijo es visible. Axeda valida el menú al arrancar
(claves únicas, sin ciclos, máximo 3 niveles, rutas seguras) y a cada persona le devuelve solo lo
que puede usar en el alcance pedido, en su idioma, con las acciones adicionales que puede hacer.
**Un menú es una comodidad, no seguridad**: el servidor impone cada permiso de todos modos.

## Revocación inmediata

Cada usuario lleva un número de versión que sube cuando cambian sus asignaciones o su estado, y
uno global sube cuando cambian las funciones. Los permisos en caché solo se usan si ambas
versiones siguen coincidiendo con lo que dice la base de datos, así que revocar un permiso surte
efecto en la siguiente petición, en cada instancia del servidor.

## Auditoría

Toda acción administrativa, con éxito o denegada, se añade a un registro de auditoría: quién, qué,
sobre qué objetivo, en qué alcance, desde qué dirección. Solo se añade, nunca se modifica; las
denegaciones se registran aunque la operación se haya deshecho. Se lee con
`GET /axeda/audit/list` y el permiso `axeda:audit:read`.
