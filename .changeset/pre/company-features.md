---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Add features per company: the modules a platform sells, switched on per company by the platform.

- `axeda({ features: { inventory: { permissions: ['inventory:*'] } } })` declares each feature and the permissions that depend on it (never Axeda ones). A feature is off unless `enabledByDefault`.
- Where a company does not have a feature, its permissions do not count for anyone inside that company, whatever their roles (even `*`): `can`, `effectivePermissions`, `scopesFor`, `scopeFilter`, the menu and the no-escalation check follow. Global assignments are not cut.
- `axeda.hasFeature(companyId, feature)`, `axeda.features.list` / `set` and the endpoints `GET /axeda/feature/list` and `POST /axeda/feature/set`; switching needs the new global permission `axeda:feature:manage`, is audited (`feature.set`) and takes effect on the next check.
- `/axeda/me` with a place now lists the concrete permissions of the catalog that count there, sorted, instead of the raw keys (a wildcard with exceptions would not tell the truth). `PermissionSet` gains `concrete(catalog)`.
- A `features` store in `AxedaPersistence` (Better Auth table `axedaCompanyFeature`), checked by `runPersistenceContract`. With features declared, a cold permission read makes one more query.
