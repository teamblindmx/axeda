/** Reglas de arquitectura de Axeda. Se ejecutan en el CI. */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Sin dependencias circulares entre módulos.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-is-independent',
      severity: 'error',
      comment: 'El núcleo no depende de los adaptadores ni de las utilidades de prueba.',
      from: { path: '^packages/core/src' },
      to: { path: '^packages/(better-auth|express|testing)/' },
    },
    {
      name: 'core-no-frameworks',
      severity: 'error',
      comment: 'El núcleo no importa Better Auth, Express ni módulos de Node.',
      from: { path: '^packages/core/src' },
      to: {
        path: '(^|/)node_modules/(better-auth|express)/',
        dependencyTypes: ['npm', 'npm-peer', 'npm-dev', 'npm-optional'],
      },
    },
    {
      name: 'core-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'adapters-only-depend-on-core',
      severity: 'error',
      comment: 'Los adaptadores no dependen entre sí.',
      from: { path: '^packages/(better-auth|express)/src' },
      to: { path: '^packages/(better-auth|express)/src', pathNot: '^packages/$1/src' },
    },
    {
      name: 'no-test-code-in-production',
      severity: 'error',
      from: { path: '^packages/[^/]+/src', pathNot: '^packages/testing/src' },
      to: { path: '^packages/[^/]+/test/|^packages/testing/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '(^|/)(dist|coverage|node_modules)/' },
  },
};
