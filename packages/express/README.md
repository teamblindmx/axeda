# @axeda/express

Middleware to guard the routes of an Express 5 application with Axeda permissions: `requireAuth()`, `requirePermission()` and `resolveScope()`. It denies by default, resolves the company of a business from the database and requires a trusted origin for cookie-bearing writes.

> **Status:** alpha (`0.1.0-alpha.0`); the API can still change before 1.0. Install with `npm install @axeda/express@alpha`. Documentation: [English](https://github.com/teamblindmx/axeda/tree/main/docs/en) · [Español](https://github.com/teamblindmx/axeda/tree/main/docs/es).

```ts
import { createAxedaExpress, resolveScope } from '@axeda/express';
```

Peer dependency: `express` `^5`. Express 4 is not supported.

Part of [Axeda](https://github.com/teamblindmx/axeda), hierarchical authorization (global → company → business) on top of [Better Auth](https://www.better-auth.com). Licensed under [Apache-2.0](LICENSE).
