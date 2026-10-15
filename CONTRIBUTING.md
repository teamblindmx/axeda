# Cómo contribuir a Axeda

## Requisitos

- Node.js 22 o superior.
- `npm install` en la raíz instala todos los paquetes del monorepo.

## Comandos

| Comando                           | Qué hace                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `npm run check`                   | Todo lo que valida el CI: tipos, lint, formato, reglas de arquitectura y pruebas |
| `npm run typecheck`               | Comprobación de tipos (TypeScript estricto)                                      |
| `npm run lint`                    | ESLint, incluidas las reglas de capas del núcleo                                 |
| `npm run format` / `format:check` | Formatea o comprueba el formato con Prettier                                     |
| `npm run deps:check`              | Reglas de arquitectura con dependency-cruiser (capas y sin ciclos)               |
| `npm test` / `npm run test:watch` | Pruebas con Vitest                                                               |
| `npm run coverage`                | Informe de cobertura (orientativo, no bloquea)                                   |
| `npm run changeset`               | Añade una nota de cambio para la próxima versión                                 |

## Flujo de ramas

```
feat/…  fix/…  chore/…  ──PR (squash)──►  develop  ──PR de release (merge)──►  main  ──► tag ──► npm
hotfix/…  ◄── desde main ──►  main  ──► se devuelve a develop
```

| Rama                                                      | Uso                                      | Reglas                                                           |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `main`                                                    | Solo versiones publicadas                | Protegida; solo PR desde `develop` o `hotfix/*`, con CI en verde |
| `develop`                                                 | Integración de lo terminado              | Protegida; solo PR con CI en verde                               |
| `feat/` `fix/` `chore/` `docs/` `test/` `refactor/` `ci/` | Una rama por tarea, desde `develop`      | Corta (días); PR pequeño (unos cientos de líneas)                |
| `spike/`                                                  | Prototipos para aprender                 | No se fusiona el código; solo se aplican sus conclusiones        |
| `hotfix/`                                                 | Arreglo urgente de una versión publicada | Sale de `main`, vuelve a `main` y se lleva a `develop`           |

- **Tarea → `develop`:** _squash merge_, con el título del PR en formato Conventional Commits.
- **`develop` → `main`:** _merge_ normal (no squash), para que ambas ramas no diverjan.
- Nunca `push --force` en `main` ni `develop`; en ramas propias, solo `--force-with-lease`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), en inglés y en imperativo:

```
feat(core): add scope inheritance to effective permissions
fix(better-auth): bump authzVersion inside the assignment transaction
```

Tipos: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `build`, `ci`, `chore`. Un commit = un cambio lógico. El cuerpo explica **por qué**. Cambios incompatibles: `!` tras el tipo y `BREAKING CHANGE:` en el pie.

## Versiones y publicación

- Semver con [Changesets](https://github.com/changesets/changesets). Hasta la 1.0 las versiones son `0.x`.
- Todo PR que cambie el comportamiento de un paquete incluye un changeset (`npm run changeset`).
- Los paquetes están marcados `"private": true` hasta la primera versión publicable; nadie publica desde su equipo. La publicación se hará desde el CI con _provenance_.

## Reglas de arquitectura

- `@axeda/core` no importa Better Auth, Express, módulos `node:*` ni `process` (lo vigilan ESLint y dependency-cruiser).
- Los adaptadores (`better-auth`, `express`) dependen solo del núcleo, no entre sí.
- El código de producción no importa utilidades de prueba.

## Seguridad

Las vulnerabilidades se reportan en privado; ver [SECURITY.md](SECURITY.md). Nunca subas secretos (`.env`, claves, tokens).
