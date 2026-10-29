# Proteger rutas con Express

`@axeda/express` protege las rutas de **tu** aplicación con los mismos permisos que administra
Axeda. Está pensado para Express 5 (Express 4 no está soportado).

```ts
import { createAxedaExpress, resolveScope } from '@axeda/express';
import { sessionPrincipal } from '@axeda/better-auth';

const x = createAxedaExpress({
  axeda: axedaPlugin.instance(),
  principal: sessionPrincipal(auth), // cómo saber quién llama
  trustedOrigins: ['https://app.example.com'], // defensa contra CSRF, ver abajo
});
```

| Método                                | Hace                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `x.requireAuth()`                     | Exige una sesión. Sin ella: `401`                              |
| `x.requirePermission(perm, options?)` | Exige sesión **y** el permiso en el alcance de la ruta         |
| `x.principalOf(req)`                  | Quién llama (solo detrás de alguno de los dos anteriores)      |
| `x.scopeFilter(req, perm)`            | Dónde tiene quien llama un permiso, para filtrar tus consultas |

## Patrón 1 — recursos de una compañía

```ts
const inCompany = resolveScope({ company: 'companyId' });

app.get(
  '/companies/:companyId/invoices',
  x.requirePermission('invoice:read', { scope: inCompany }),
  listInvoices,
);
```

El id es **lo que envió el cliente; no se le cree**. Axeda lo resuelve contra la base de datos. Si
la compañía no existe, está inactiva o borrada, o la persona no tiene permiso ahí, la respuesta es
el mismo `403`.

## Patrón 2 — un negocio, y la compañía en la URL

```ts
const inBusiness = resolveScope({ company: 'companyId', business: 'businessId' });

app.post(
  '/companies/:companyId/businesses/:businessId/invoices',
  x.requirePermission('invoice:create', { scope: inBusiness }),
  createInvoice,
);
```

Cuando la ruta nombra ambos, el negocio **debe pertenecer a esa compañía** o la petición se
deniega, incluso a una persona administradora global. Una ruta solo con `{ business: 'businessId' }`
también sirve: la compañía se lee de la base de datos.

## Patrón 3 — listados

Un listado no pertenece a un alcance concreto. Pregunta dónde tiene quien llama el permiso y filtra
tu propia consulta con eso:

```ts
app.get('/invoices', x.requireAuth(), async (req, res) => {
  const where = await x.scopeFilter(req, 'invoice:read');
  // where = { unrestricted: boolean, companyIds: string[], businessIds: string[] }
  const rows = await db.invoices.filter(
    (i) =>
      where.unrestricted ||
      where.companyIds.includes(i.companyId) ||
      (i.businessId && where.businessIds.includes(i.businessId)),
  );
  res.json({ items: rows });
});
```

## Patrón 4 — un recurso concreto

Un permiso en la compañía de la ruta no dice nada del id del recurso. Comprueba que le pertenece
y responde exactamente como si no existiera en caso contrario:

```ts
app.delete(
  '/companies/:companyId/invoices/:invoiceId',
  x.requirePermission('invoice:delete', { scope: inCompany }),
  async (req, res) => {
    const invoice = await db.invoices.get(req.params.invoiceId);
    if (invoice?.companyId !== req.params.companyId) return res.status(404).end();
    // …
  },
);
```

Sin esta comprobación, quien tenga `invoice:delete` en **su** compañía podría borrar la factura de
**cualquier** compañía adivinando su id. Es el fallo de autorización más común en aplicaciones
multicompañía; la aplicación de ejemplo tiene una prueba para esto.

## De dónde sale el alcance

`resolveScope({ company, business, from })` lee parámetros de la ruta (`from: 'params'`, por
omisión) o de la consulta (`from: 'query'`, p. ej. `/invoices?companyId=…`). Todo lo inesperado
—ausente, vacío, repetido (`?companyId=a&companyId=b`), un objeto, de más de 255 caracteres— se
**deniega**, nunca se adivina. Una ruta sin `scope` se comprueba **en global**.

También puedes pasar tu propia función que devuelva `{ kind: 'global' }`,
`{ kind: 'scope', scope: { type: 'company', id } }` o `{ kind: 'invalid' }`.

## Cómo se ve una denegación

| Situación                                         | Estado | `code`                  |
| ------------------------------------------------- | ------ | ----------------------- |
| Sin sesión                                        | 401    | `AXEDA_UNAUTHENTICATED` |
| Sin permiso, o alcance ausente / que no cuadra    | 403    | `AXEDA_FORBIDDEN`       |
| Lo mismo, con `onDeny: 'not-found'`               | 404    | `AXEDA_NOT_FOUND`       |
| Escritura con cookie desde un origen no confiable | 403    | `AXEDA_CROSS_SITE`      |

Las denegaciones llevan `Cache-Control: no-store`. El cuerpo es idéntico exista o no la cosa. Usa
`onDeny: 'not-found'` en las rutas donde ni siquiera la existencia de un recurso deba conocerse.

Si consultar la sesión o los permisos **falla** (base de datos caída), la petición pasa a tu
manejador de errores y la ruta no se ejecuta: el middleware nunca abre la puerta ante un fallo.

## CSRF

Los navegadores adjuntan las cookies a peticiones entre sitios por su cuenta. En toda escritura
(`POST`, `PUT`, `PATCH`, `DELETE`) que lleve cookie, el middleware exige una cabecera `Origin` que
esté en `trustedOrigins`; un origen ausente, `null` o ajeno se rechaza. Las lecturas nunca se ven
afectadas.

Debes decidir: lista `trustedOrigins` o pasa `csrf: false` si la API nunca se autentica con
cookies (por ejemplo, solo acepta llaves de API). Omitirlo es un error.

## Lo que sigue siendo tuyo

- **CORS.** Usa el paquete `cors` con una lista explícita de orígenes y `credentials: true`; nunca `*`.
- **Cabeceras de seguridad** (`helmet`) y un **límite de tamaño del cuerpo** (`express.json({ limit })`).
- **Límites de peticiones para tus propias rutas.** Better Auth y Axeda limitan las suyas, no las tuyas.
- **Proxies.** Detrás de un proxy inverso configura `app.set('trust proxy', [...])` para que
  `req.ip` sea real; la dirección va a la auditoría.
- **Orden de montaje.** `app.all('/api/auth/*splat', toNodeHandler(auth))` va **antes** de
  `express.json()`; Better Auth lee el cuerpo por su cuenta.

## Los errores fallan pronto

`requirePermission('invoice:raed')` (un error tipográfico), un comodín, o `principalOf()` fuera de
una ruta protegida lanzan error al declarar la ruta o al primer uso, no en producción.
