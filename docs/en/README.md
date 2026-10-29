# Axeda documentation

Hierarchical authorization (**global → company → business**) for Node.js, on top of
[Better Auth](https://www.better-auth.com). Better Auth answers _who are you_; Axeda answers
_what can you do, and where_.

> **Status:** pre-release. Nothing is published on npm yet; until the first alpha, run the
> [example application](quickstart.md) from this repository.
> Documentation in Spanish: [`../es`](../es/README.md).

| Guide                           | Read it to…                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| [Quick start](quickstart.md)    | Run the example, then add Axeda to your own app                                      |
| [Concepts](concepts.md)         | Understand scopes, permissions, roles, assignments, companies, invitations and menus |
| [Protecting routes](express.md) | Use `requirePermission()` and `resolveScope()` in Express                            |
| [Security](security.md)         | Configure Better Auth safely, know what Axeda guarantees and what is still yours     |
| [Reference](reference.md)       | Look up endpoints, error codes, options and the TypeScript API                       |
| [Testing](testing.md)           | Test your app with the in-memory stores                                              |

## How the pieces fit

```
 Your app ──► Better Auth ──► @axeda/better-auth plugin ──► @axeda/core
              (identity)       · tables (via Better Auth)     · authorization policy
                               · /axeda/* endpoints           · use cases
                               · hooks                        · ports
                               · typed client                       ▲
                                                                    │
                               @axeda/express ── requirePermission() ┘   (guards your routes)
```

| Package              | What it is                                                                       |
| -------------------- | -------------------------------------------------------------------------------- |
| `@axeda/core`        | The policy and the use cases. No dependency on Better Auth or any HTTP framework |
| `@axeda/better-auth` | The Better Auth plugin, the typed client, `secureAuthOptions()` and the stores   |
| `@axeda/express`     | Middleware for your Express routes                                               |
| `@axeda/testing`     | In-memory stores and the contract suites for the ports                           |

Verified databases: **SQLite** and **PostgreSQL**. MySQL and MongoDB are planned, not supported yet.
