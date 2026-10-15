# Changesets

Cada PR que cambie el comportamiento de un paquete añade un *changeset*:

```bash
npm run changeset
```

Elige los paquetes afectados, el tipo de cambio (patch, minor o major) y escribe una frase sobre qué cambia para quien usa la librería. Al publicar una versión, Changesets calcula la versión y genera el CHANGELOG a partir de estos archivos. Ver `CONTRIBUTING.md`.
