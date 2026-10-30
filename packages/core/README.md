# @axeda/core

The authorization policy and use cases of Axeda: effective permissions with downward inheritance, anti-escalation rules, companies, businesses, invitations, users, menus and audit. It depends on neither Better Auth nor any HTTP framework; it talks to storage through ports.

> **Status:** pre-release. Not published on npm yet. Documentation: [English](https://github.com/teamblindmx/axeda/tree/main/docs/en) · [Español](https://github.com/teamblindmx/axeda/tree/main/docs/es).

```ts
import { createAxeda } from '@axeda/core';
```

Most applications use it through [`@axeda/better-auth`](https://github.com/teamblindmx/axeda/tree/main/packages/better-auth) and only import types or `createAxeda` directly for tests.

Part of [Axeda](https://github.com/teamblindmx/axeda), hierarchical authorization (global → company → business) on top of [Better Auth](https://www.better-auth.com). Licensed under [Apache-2.0](LICENSE).
