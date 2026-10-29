# Protecting routes with Express

`@axeda/express` guards the routes of **your** application with the same permissions Axeda
manages. It targets Express 5 (Express 4 is not supported).

```ts
import { createAxedaExpress, resolveScope } from '@axeda/express';
import { sessionPrincipal } from '@axeda/better-auth';

const x = createAxedaExpress({
  axeda: axedaPlugin.instance(),
  principal: sessionPrincipal(auth), // how to know who is calling
  trustedOrigins: ['https://app.example.com'], // CSRF defence, see below
});
```

| Method                                | Does                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `x.requireAuth()`                     | Requires a session. Without one: `401`                         |
| `x.requirePermission(perm, options?)` | Requires a session **and** the permission in the route's scope |
| `x.principalOf(req)`                  | Who is calling (only behind one of the two above)              |
| `x.scopeFilter(req, perm)`            | Where the caller holds a permission, to filter your queries    |

## Pattern 1 — a company's resources

```ts
const inCompany = resolveScope({ company: 'companyId' });

app.get(
  '/companies/:companyId/invoices',
  x.requirePermission('invoice:read', { scope: inCompany }),
  listInvoices,
);
```

The id is **what the client sent; it is not trusted**. Axeda resolves it against the database.
If the company does not exist, is inactive or deleted, or the user has no permission there, the
answer is the same `403`.

## Pattern 2 — a business, and the company in the URL

```ts
const inBusiness = resolveScope({ company: 'companyId', business: 'businessId' });

app.post(
  '/companies/:companyId/businesses/:businessId/invoices',
  x.requirePermission('invoice:create', { scope: inBusiness }),
  createInvoice,
);
```

When the route names both, the business **must belong to that company** or the request is denied
— even for a global administrator. A route with only `{ business: 'businessId' }` also works: the
company is read from the database.

## Pattern 3 — lists

A list belongs to no single scope. Ask where the caller holds the permission and filter your own
query with it:

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

## Pattern 4 — one concrete resource

A permission in the route's company says nothing about the resource's id. Check that it belongs
there, and answer exactly as if it did not exist otherwise:

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

Without this check, anyone with `invoice:delete` in **their** company could delete **any**
company's invoice by guessing its id. It is the most common authorization bug in multi-tenant
apps; the example application has a test for it.

## Where the scope comes from

`resolveScope({ company, business, from })` reads route parameters (`from: 'params'`, the
default) or query parameters (`from: 'query'`, e.g. `/invoices?companyId=…`). Anything
unexpected — missing, empty, repeated (`?companyId=a&companyId=b`), an object, longer than 255
characters — is **denied**, never guessed. A route with no `scope` is checked **globally**.

You can also pass your own function returning `{ kind: 'global' }`,
`{ kind: 'scope', scope: { type: 'company', id } }` or `{ kind: 'invalid' }`.

## What a denial looks like

| Situation                                      | Status | `code`                  |
| ---------------------------------------------- | ------ | ----------------------- |
| No session                                     | 401    | `AXEDA_UNAUTHENTICATED` |
| No permission, or scope missing / not matching | 403    | `AXEDA_FORBIDDEN`       |
| Same, with `onDeny: 'not-found'`               | 404    | `AXEDA_NOT_FOUND`       |
| Cookie write from an untrusted origin          | 403    | `AXEDA_CROSS_SITE`      |

Denials carry `Cache-Control: no-store`. The body is identical whether the thing exists or not.
Use `onDeny: 'not-found'` on routes where even the existence of a resource should stay secret.

If looking up the session or the permissions **fails** (database down), the request is handed to
your error handler and the route does not run: the middleware never fails open.

## CSRF

Browsers attach cookies to cross-site requests on their own. For any write (`POST`, `PUT`,
`PATCH`, `DELETE`) that carries a cookie, the middleware requires an `Origin` header that is in
`trustedOrigins`; a missing, `null` or foreign origin is refused. Reads are never affected.

You must decide: list `trustedOrigins`, or pass `csrf: false` if the API never authenticates with
cookies (for example it only accepts API keys). Leaving it out is an error.

## Things that stay yours

- **CORS.** Use the `cors` package with an explicit list of origins and `credentials: true`; never `*`.
- **Security headers** (`helmet`) and a **body size limit** (`express.json({ limit })`).
- **Rate limits for your own routes.** Better Auth and Axeda limit theirs, not yours.
- **Proxies.** Behind a reverse proxy set `app.set('trust proxy', [...])` so `req.ip` is real; the
  address goes to the audit log.
- **Mount order.** `app.all('/api/auth/*splat', toNodeHandler(auth))` goes **before**
  `express.json()`; Better Auth reads the body itself.

## Mistakes fail early

`requirePermission('invoice:raed')` (a typo), a wildcard, or `principalOf()` outside a guarded
route throw when the route is declared or first used, not in production.
