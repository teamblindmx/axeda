# Documentación de Axeda

Autorización jerárquica (**global → compañía → negocio**) para Node.js, sobre
[Better Auth](https://www.better-auth.com). Better Auth responde _quién eres_; Axeda responde
_qué puedes hacer y dónde_.

> **Estado:** previo a la primera versión. Aún no hay nada publicado en npm; hasta la primera
> alpha, ejecuta la [aplicación de ejemplo](quickstart.md) desde este repositorio.
> Documentation in English: [`../en`](../en/README.md).

| Guía                           | Léela para…                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| [Inicio rápido](quickstart.md) | Ejecutar el ejemplo y luego añadir Axeda a tu aplicación                                |
| [Conceptos](concepts.md)       | Entender alcances, permisos, funciones, asignaciones, compañías, invitaciones y menús   |
| [Proteger rutas](express.md)   | Usar `requirePermission()` y `resolveScope()` en Express                                |
| [Seguridad](security.md)       | Configurar Better Auth con seguridad, saber qué garantiza Axeda y qué sigue siendo tuyo |
| [Referencia](reference.md)     | Consultar endpoints, códigos de error, opciones y la API de TypeScript                  |
| [Pruebas](testing.md)          | Probar tu aplicación con los almacenes en memoria                                       |

## Cómo encajan las piezas

```
 Tu app ──► Better Auth ──► plugin @axeda/better-auth ──► @axeda/core
            (identidad)      · tablas (vía Better Auth)     · política de autorización
                             · endpoints /axeda/*           · casos de uso
                             · hooks                        · puertos
                             · cliente tipado                     ▲
                                                                  │
                             @axeda/express ── requirePermission() ┘   (protege tus rutas)
```

| Paquete              | Qué es                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| `@axeda/core`        | La política y los casos de uso. Sin dependencia de Better Auth ni de un framework HTTP |
| `@axeda/better-auth` | El plugin de Better Auth, el cliente tipado, `secureAuthOptions()` y los almacenes     |
| `@axeda/express`     | Middleware para tus rutas de Express                                                   |
| `@axeda/testing`     | Almacenes en memoria y las suites de contrato de los puertos                           |

Bases de datos verificadas: **SQLite** y **PostgreSQL**. MySQL y MongoDB están previstas, aún no se soportan.
