# Axeda

**Hierarchical authorization for Node.js on top of [Better Auth](https://www.better-auth.com).**
Axeda decides **what each user can do and where**: global → company → business, with permissions declared in code, scoped role assignments, companies and businesses, and menus derived from permissions.

> **Status:** early development. Nothing is published yet and the API is not usable.

**Autorización jerárquica para Node.js sobre Better Auth.** Axeda decide **qué puede hacer cada usuario y dónde** (global → compañía → negocio). **Estado:** en desarrollo inicial; aún no hay nada publicado.

## Packages

| Package              | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `@axeda/core`        | Authorization policy, use cases and ports. No Better Auth or framework dependencies |
| `@axeda/better-auth` | Better Auth plugin: schema, endpoints, typed client, store implementations          |
| `@axeda/express`     | `requirePermission()` and `resolveScope()` for Express routes                       |
| `@axeda/testing`     | In-memory stores and port contract suites                                           |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
