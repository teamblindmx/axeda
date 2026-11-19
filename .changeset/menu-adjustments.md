---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Adjust the menu through the API without deploying: hide an item (with everything under it), reorder it among its siblings or rename it per language, for everyone (global) or inside one company, whose businesses and sites inherit it.

- New permission `axeda:menu:manage` (global or company), `axeda.menuAdjustments.list` / `set` / `reset` and the endpoints `/axeda/menu-adjustment/{list,set,reset}` (typed client: `client.axeda.menuAdjustment.*`).
- Only items declared in code can be adjusted; their path and permission never change, so an adjustment can neither add a link nor show an option to someone without its permission. Company adjustments win over global ones field by field.
- Changes are audited (`menu.adjust`, `menu.reset`); purging a company deletes its adjustments. `applyMenuAdjustments` is exported for custom menus.
- A `menuAdjustments` store in `AxedaPersistence` (Better Auth table `axedaMenuAdjustment`), checked by `runPersistenceContract`.
