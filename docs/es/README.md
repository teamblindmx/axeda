# Documentación de Axeda

Autorización jerárquica (**global → compañía → negocio**) para Node.js, sobre
[Better Auth](https://www.better-auth.com). Better Auth responde _quién eres_; Axeda responde
_qué puedes hacer y dónde_.

> **Estado:** alfa (`0.1.0-alpha.0`). Instala con la etiqueta `alpha` (`npm install @axeda/core@alpha @axeda/better-auth@alpha @axeda/express@alpha better-auth express`),
> o ejecuta la [aplicación de ejemplo](quickstart.md) desde este repositorio. La API aún puede cambiar antes de la 1.0.
> Documentation in English: [`../en`](../en/README.md).

| Guía                           | Léela para…                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| [Inicio rápido](quickstart.md) | Ejecutar el ejemplo y luego añadir Axeda a tu aplicación                                |
| [Conceptos](concepts.md)       | Entender alcances, permisos, funciones, asignaciones, compañías, invitaciones y menús   |
| [Proteger rutas](express.md)   | Usar `requirePermission()` y `resolveScope()` en Express                                |
| [Seguridad](security.md)       | Configurar Better Auth con seguridad, saber qué garantiza Axeda y qué sigue siendo tuyo |
| [Referencia](reference.md)     | Consultar endpoints, códigos de error, opciones y la API de TypeScript                  |
| [Registro ASVS](asvs.md)       | Ver qué garantiza Axeda frente al estándar de OWASP, qué se delega y qué sigue abierto  |
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

## Compatibilidad

| Componente     | Soportado                                                                               |
| -------------- | --------------------------------------------------------------------------------------- |
| Node.js        | 22 y 24                                                                                 |
| Better Auth    | `^1.7.10`; el CI corre la 1.7.10 (la mínima) y la 1.7.14, y vigila la beta 1.8          |
| Módulos        | Solo módulos ES. Desde CommonJS usa `import()`, o `require()` en Node 22.12 o posterior |
| Express        | 5 (Express 4 no está soportado)                                                         |
| Bases de datos | SQLite y PostgreSQL (16 y 18 en el CI). MySQL y MongoDB: todavía no                     |
