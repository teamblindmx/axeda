---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-express': minor
'@teamblind/axeda-testing': minor
---

Add sites: a fourth scope under the company. A site always belongs to a company and, optionally, to one of its businesses, so a company can have sites without businesses. A company assignment applies to all its sites, a business assignment to the sites of that business, and a site assignment only to that site. An inactive or deleted company or business blocks its sites, and purging a business or a company purges its sites. The employees of a site are the people with a role assigned in it.

- Sites are managed with the new permission `axeda:site:manage`, from the company or from the business they hang from, through `axeda.sites` and the endpoints `/axeda/site/{list,get,create,update,set-status,delete,restore}`. A site that is not visible answers `AXEDA_SITE_NOT_FOUND` (404).
- Assignments, invitations, the menu and the audit log accept the scope `{ type: 'site', id }`. `scopeFilter` returns `siteIds`, `purgeDeleted()` returns `sites`, and `axeda:assignment:manage` and `axeda:invitation:manage` are valid in a site.
- `GET /axeda/me` takes an optional place (`?scopeType=site&scopeId=…`, also a company or a business) and then returns `permissions`: what the caller may do there, for a front end. Without it the answer is the same as before.
- Express: `resolveScope({ site: 'siteId' })`, also with the company and the business in the URL, which must match the database.
- Better Auth's migration creates the new table `axedaSite`; nothing else changes in existing tables.
- If you wrote your own persistence (instead of the Better Auth or the memory one), `AxedaPersistence` now needs a `sites` store, and purging a company or a business must purge its sites; `runPersistenceContract` checks it.
