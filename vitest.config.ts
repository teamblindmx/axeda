import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@teamblind/axeda-core': src('core'),
      '@teamblind/axeda-better-auth': src('better-auth'),
      '@teamblind/axeda-express': src('express'),
      '@teamblind/axeda-testing': src('testing'),
    },
  },
  test: {
    // Registrar usuarios en Better Auth cifra la contraseña (scrypt): es lento a propósito.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text', 'html'],
    },
  },
});
