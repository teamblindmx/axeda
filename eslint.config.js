import tseslint from 'typescript-eslint';

/** Imports que el núcleo nunca puede usar: debe ser independiente de Better Auth, del framework HTTP y de Node. */
const CORE_FORBIDDEN_IMPORTS = [
  {
    group: ['node:*'],
    message: 'El núcleo usa solo APIs estándar; lo específico de Node va en los adaptadores.',
  },
  {
    group: ['better-auth', 'better-auth/*', '@teamblind/axeda-better-auth'],
    message: 'El núcleo no depende de Better Auth.',
  },
  {
    group: ['express', '@teamblind/axeda-express'],
    message: 'El núcleo no depende del framework HTTP.',
  },
  {
    group: ['@teamblind/axeda-testing'],
    message: 'El código de producción no importa utilidades de prueba.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'coverage/**', '.*/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      complexity: ['error', 10],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: CORE_FORBIDDEN_IMPORTS }],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'El núcleo recibe su configuración; no lee el entorno.' },
      ],
    },
  },
  {
    // Estos archivos son CommonJS a propósito: prueban a quien usa `require()`.
    files: ['scripts/**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: [
      'packages/*/test/**/*.ts',
      'apps/*/test/**/*.ts',
      'apps/*/src/**/*.ts',
      'bench/**/*.ts',
      'scripts/**/*.{mjs,cjs,ts}',
      'examples/**/*.ts',
      'vitest.config.ts',
    ],
    rules: { 'no-console': 'off' },
  },
);
