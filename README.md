# Axeda

**Hierarchical authorization for Node.js on top of [Better Auth](https://www.better-auth.com).**
Axeda decides **what each user can do and where**: global → company → business, with permissions declared in code, scoped role assignments, companies and businesses, and menus derived from permissions.

> **Status:** alpha (`0.1.0-alpha.0`). Feature-complete for a first look (authorization, companies and businesses, invitations, users and menus, Express middleware, a runnable example), but the API can still change before 1.0.
>
> ```bash
> npm install @teamblind/axeda-core@alpha @teamblind/axeda-better-auth@alpha @teamblind/axeda-express@alpha better-auth @better-auth/core express
> ```
>
> See the [documentation](docs/en/README.md) and the [quick start](docs/en/quickstart.md).

**Autorización jerárquica para Node.js sobre Better Auth.** Axeda decide **qué puede hacer cada usuario y dónde** (global → compañía → negocio). **Estado:** alfa (`0.1.0-alpha.0`); la API aún puede cambiar antes de la 1.0. Instala con la etiqueta `alpha` (comando arriba). Mira la [documentación](docs/es/README.md) y el [inicio rápido](docs/es/quickstart.md).

## Packages

| Package                        | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `@teamblind/axeda-core`        | Authorization policy, use cases and ports. No Better Auth or framework dependencies |
| `@teamblind/axeda-better-auth` | Better Auth plugin: schema, endpoints, typed client, store implementations          |
| `@teamblind/axeda-express`     | `requirePermission()` and `resolveScope()` for Express 5 routes                     |
| `@teamblind/axeda-testing`     | In-memory stores and port contract suites                                           |

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
