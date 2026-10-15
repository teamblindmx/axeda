import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@axeda/core': src('core'),
      '@axeda/better-auth': src('better-auth'),
      '@axeda/express': src('express'),
      '@axeda/testing': src('testing'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Fase 0: aún no hay pruebas. Se quitará cuando llegue el código de la fase 1.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text', 'html'],
    },
  },
});
