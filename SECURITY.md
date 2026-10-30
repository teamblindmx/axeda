# Security policy / Política de seguridad

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub: go to the **Security** tab of this repository and choose **Report a vulnerability**. Include a description, the affected version, steps to reproduce and the impact you expect.

Our goals:

- Acknowledge the report within **5 business days**.
- Share an initial assessment within **10 business days**.
- Publish a fix and a security advisory as soon as a patch is ready, crediting the reporter unless they prefer otherwise.

## Supported versions

Axeda is in early development (`0.x`). Only the **latest published version** receives security fixes.

## Scope

Axeda handles **authorization** (who can do what, and where). Authentication (passwords, sessions, 2FA, OAuth) is provided by [Better Auth](https://www.better-auth.com); vulnerabilities in Better Auth itself should be reported to that project.

What we treat as a vulnerability in Axeda: anything that lets someone do what their roles do not allow, such as bypassing a permission check, escalating privileges (granting, editing a role or acting on a user above their own level), reaching another company's data, using a revoked permission, a banned account keeping access, an invitation accepted by someone it was not meant for, a secret or personal data leaking through an API response, or a configuration that silently weakens a protection the documentation promises.

## Third-party components

The published packages have a single third-party runtime dependency (`zod`); `better-auth` and `express` are peers chosen by the application. Remediation targets once a vulnerability in a component we ship or test against is public:

| Severity         | Target                                              |
| ---------------- | --------------------------------------------------- |
| Critical or high | Fixed or mitigated, and released, within **7 days** |
| Moderate         | Within **30 days**                                  |
| Low              | In the next regular release                         |

How we notice: `npm audit` runs on every pull request and again **every week** (with a check of registry signatures and provenance), Dependabot proposes updates, and an inventory of components (CycloneDX) is produced by `npm run sbom` and kept with each CI run. GitHub Actions are pinned to a commit.

---

## Reportar una vulnerabilidad

**No abras un issue público para problemas de seguridad.**

Repórtala de forma privada desde GitHub: pestaña **Security** de este repositorio → **Report a vulnerability**. Incluye una descripción, la versión afectada, los pasos para reproducirla y el impacto que esperas.

Nuestros objetivos: acusar recibo en **5 días hábiles**, dar una primera evaluación en **10 días hábiles** y publicar el arreglo con un aviso de seguridad en cuanto esté listo, con crédito a quien lo reportó si así lo desea.

Lo que consideramos una vulnerabilidad de Axeda: todo lo que permita hacer algo que los roles de la persona no permiten (saltarse una comprobación de permisos, escalar privilegios, llegar a los datos de otra compañía, usar un permiso revocado, que una cuenta bloqueada conserve acceso, que una invitación la acepte quien no debía, que una respuesta filtre un secreto o datos personales) o una configuración que debilite en silencio una protección que la documentación promete.

Componentes de terceros: los paquetes publicados tienen una sola dependencia de ejecución (`zod`). Plazos una vez pública una vulnerabilidad en un componente que distribuimos o con el que probamos: **crítica o alta, 7 días** (arreglada o mitigada y publicada); **moderada, 30 días**; **baja**, en la siguiente versión regular. `npm audit` corre en cada pull request y **cada semana** (con verificación de firmas y procedencia), Dependabot propone actualizaciones, `npm run sbom` genera el inventario de componentes (CycloneDX) y las acciones de GitHub están fijadas por commit.

Mientras Axeda esté en `0.x`, solo la **última versión publicada** recibe arreglos de seguridad. Las vulnerabilidades de la autenticación (Better Auth) se reportan a ese proyecto.
