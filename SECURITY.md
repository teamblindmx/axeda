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

---

## Reportar una vulnerabilidad

**No abras un issue público para problemas de seguridad.**

Repórtala de forma privada desde GitHub: pestaña **Security** de este repositorio → **Report a vulnerability**. Incluye una descripción, la versión afectada, los pasos para reproducirla y el impacto que esperas.

Nuestros objetivos: acusar recibo en **5 días hábiles**, dar una primera evaluación en **10 días hábiles** y publicar el arreglo con un aviso de seguridad en cuanto esté listo, con crédito a quien lo reportó si así lo desea.

Mientras Axeda esté en `0.x`, solo la **última versión publicada** recibe arreglos de seguridad. Las vulnerabilidades de la autenticación (Better Auth) se reportan a ese proyecto.
