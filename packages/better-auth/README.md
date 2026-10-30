# @axeda/better-auth

The Better Auth plugin for Axeda: schema, `/axeda/*` endpoints, the typed client, `secureAuthOptions()` and the stores that persist everything through Better Auth's database adapter (SQLite and PostgreSQL verified).

> **Status:** pre-release. Not published on npm yet. Documentation: [English](https://github.com/teamblindmx/axeda/tree/main/docs/en) · [Español](https://github.com/teamblindmx/axeda/tree/main/docs/es).

```ts
import { axeda, secureAuthOptions, sessionPrincipal } from '@axeda/better-auth';
import { axedaClient } from '@axeda/better-auth/client';
```

Peer dependencies: `better-auth` and `@better-auth/core` (`^1.7.10`; tested on 1.7.10 and 1.7.14).

Part of [Axeda](https://github.com/teamblindmx/axeda), hierarchical authorization (global → company → business) on top of [Better Auth](https://www.better-auth.com). Licensed under [Apache-2.0](LICENSE).
