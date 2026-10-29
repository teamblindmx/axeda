# Axeda

**Hierarchical authorization for Node.js on top of [Better Auth](https://www.better-auth.com).**
Axeda decides **what each user can do and where**: global → company → business, with permissions declared in code, scoped role assignments, companies and businesses, and menus derived from permissions.

> **Status:** pre-release. Nothing is published on npm yet, but the library is feature-complete for the first alpha: authorization, companies and businesses, invitations, users and menus, Express middleware and a runnable example. See the [documentation](docs/en/README.md) and the [quick start](docs/en/quickstart.md).

**Autorización jerárquica para Node.js sobre Better Auth.** Axeda decide **qué puede hacer cada usuario y dónde** (global → compañía → negocio). **Estado:** previo a la primera versión; aún no hay nada publicado en npm. Mira la [documentación](docs/es/README.md) y el [inicio rápido](docs/es/quickstart.md).

## Packages

| Package              | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `@axeda/core`        | Authorization policy, use cases and ports. No Better Auth or framework dependencies |
| `@axeda/better-auth` | Better Auth plugin: schema, endpoints, typed client, store implementations          |
| `@axeda/express`     | `requirePermission()` and `resolveScope()` for Express 5 routes                     |
| `@axeda/testing`     | In-memory stores and port contract suites                                           |

## Documentation

| English                                 | Español                                |
| --------------------------------------- | -------------------------------------- |
| [Quick start](docs/en/quickstart.md)    | [Inicio rápido](docs/es/quickstart.md) |
| [Concepts](docs/en/concepts.md)         | [Conceptos](docs/es/concepts.md)       |
| [Protecting routes](docs/en/express.md) | [Proteger rutas](docs/es/express.md)   |
| [Security](docs/en/security.md)         | [Seguridad](docs/es/security.md)       |
| [Reference](docs/en/reference.md)       | [Referencia](docs/es/reference.md)     |

A runnable API lives in [`apps/example`](apps/example).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
