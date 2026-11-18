# Upgrading

## From `0.1.0-alpha.1` to `0.1.0-alpha.2`

Nothing you use today changes its behaviour: sites are new and additive. You have to run the database
migration, and two cases need a look.

| What changed                                                           | Do you need to act?                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Sites, a new scope under the company                                   | Only if you want them ([below](#sites))                                 |
| A new table, `axedaSite`                                               | **Yes**: run the migration ([below](#the-migration-for-sites))          |
| `AxedaPersistence` needs a `sites` store                               | Only if you wrote your own persistence ([below](#your-own-persistence)) |
| `scopeFilter` returns `siteIds` and `purgeDeleted()` returns `sites`   | Only if your code compares those objects field by field                 |
| `GET /axeda/me` takes an optional place and then returns `permissions` | No; see [Reference](reference.md#endpoints)                             |

### Sites

A site is a place of a company. It always belongs to a company and, optionally, to one of its
businesses, so a company can have sites without businesses. A role assigned in the company applies
to all its sites, one in a business to the sites of that business, and one in a site only there. The
employees of a site are the people with a role assigned in it. You manage sites with the new
permission `axeda:site:manage`, from the company or from the business they hang from.

```ts
// A site directly under the company, and one under a business of that company
await axeda.sites.create(actor, companyId, { slug: 'hq', name: 'Headquarters' });
await axeda.sites.create(actor, companyId, { slug: 'north', name: 'North', businessId });

// An employee: a role assigned in the site
await axeda.assignments.assign(actor, { userId, roleId, scope: { type: 'site', id: siteId } });

// An Express route of a site; its company and business come from the database
app.get(
  '/companies/:companyId/sites/:siteId/invoices',
  x.requirePermission('invoice:read', {
    scope: resolveScope({ company: 'companyId', site: 'siteId' }),
  }),
  listInvoices,
);
```

### The migration for sites

Run Better Auth's migration as usual. It creates the table `axedaSite` and changes no existing
table. MongoDB has no migrations: the collection is created on first use.

### Your own persistence

If you implemented `AxedaPersistence` yourself, add a `sites` store (`SiteStore`), and make purging
a company or a business also purge its sites with their assignments and invitations.
`runPersistenceContract` from `@teamblind/axeda-testing` checks all of it.

## From `0.1.0-alpha.0` to `0.1.0-alpha.1`

No exported function, type or option was removed or renamed: the only addition to the API is the
`maxSessionAge` option. You do not have to change your code. You **do** have to run the database migration,
and one default changes how long sessions live.

| What changed                                | Do you need to act?                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Sessions now end 30 days after sign-in      | Decide: keep it, change it or turn it off ([below](#1-sessions-now-have-an-absolute-lifetime)) |
| New indexes on the Axeda tables             | **Yes**: run the migration ([below](#2-run-the-migration))                                     |
| MySQL tables created by a development build | Only then: one `ALTER` first ([below](#3-mysql-only-an-existing-table))                        |
| Audit event ids are shorter                 | No ([below](#4-audit-event-ids))                                                               |
| MySQL and MongoDB are supported             | No; see [Configuration](configuration.md#database-specific-settings)                           |

### Install

The four packages are published together at the same version:

```bash
npm install @teamblind/axeda-core@alpha @teamblind/axeda-better-auth@alpha @teamblind/axeda-express@alpha
npm install --save-dev @teamblind/axeda-testing@alpha
```

### 1. Sessions now have an absolute lifetime

Better Auth renews a session each time it is used, so a session in daily use never ended. Axeda now caps it:
a session never lives past its creation plus `maxSessionAge`, **30 days by default**. Sessions that are
already older than that are cut the next time Better Auth renews them, and the user signs in again.

```ts
axeda({ permissions, maxSessionAge: 60 * 60 * 24 * 90 }); // 90 days
axeda({ permissions, maxSessionAge: false }); // the old behaviour: no absolute limit
```

While the limit holds a session back, Better Auth writes the session row on every request during the last
`expiresIn` minus `updateAge` of its life (6 days with the preset), instead of once a day. See
[Session lifetime](configuration.md#session-lifetime).

### 2. Run the migration

Run Better Auth's migration as you did when you installed Axeda:

```ts
await (await getMigrations(options)).runMigrations();
```

It adds five indexes and keeps every row:

- A unique index on the role key, the company slug, the policy state key and the pending invitation key.
  They used to be a `unique` column; the column constraint stays, so each of these tables ends up with
  both (four small, redundant indexes). Duplicates are still refused.
- An index on the `action` column of the audit log. Listing the audit log by action used to read the whole
  table; with 200,000 events it took 51 to 74 ms in PostgreSQL 16 and 18, and with the index it takes a
  fraction of a millisecond.

Running it twice is safe. On a large existing SQL database, building an index can block writes to that
table while it runs, so pick a quiet moment. After it, `await axedaPlugin.start()` should succeed as before.

MongoDB has no migrations: the adapter creates the indexes the first time it uses each collection.

### 3. MySQL only: an existing table

Better Auth creates string columns without an index as `text`, and on MySQL it will not index an existing
`text` column. If the audit table already exists on MySQL, bound the column once **before** the migration:

```sql
ALTER TABLE axedaAudit MODIFY action varchar(255) NOT NULL;
```

Otherwise the migration stops with `can exceed MySQL's 3072-byte index-key limit`. `0.1.0-alpha.0` did not
support MySQL, so this concerns only tables created by a development build. A new MySQL database is not
affected.

### 4. Audit event ids

New events get ids of 36 characters instead of 50, so they fit the `varchar(36)` id column Better Auth
creates on MySQL. Events already stored keep their ids and their place in the order, and ids still sort by
time. Treat an id as opaque: do not parse it.
