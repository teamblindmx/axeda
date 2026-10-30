# @axeda/testing

In-memory stores for Axeda and the contract suites that every persistence implementation must pass, for testing your own authorization logic without a database.

> **Status:** pre-release. Not published on npm yet. Documentation: [English](https://github.com/teamblindmx/axeda/tree/main/docs/en) · [Español](https://github.com/teamblindmx/axeda/tree/main/docs/es).

```ts
import { createMemoryPersistence, createMemoryUserDirectory } from '@axeda/testing';
```

Peer dependency: `vitest` `^5` (the contract suites use its `describe` and `it`).

Part of [Axeda](https://github.com/teamblindmx/axeda), hierarchical authorization (global → company → business) on top of [Better Auth](https://www.better-auth.com). Licensed under [Apache-2.0](LICENSE).
