/**
 * Prueba de humo del paquete publicado: empaqueta los cuatro paquetes, los instala en un
 * proyecto VACÍO (como lo haría quien los use) y comprueba que funcionan de verdad:
 *
 *   1. en ejecución: un servidor Express + Better Auth + Axeda real, con una persona que se
 *      registra, verifica su correo, inicia sesión y es autorizada (o no) por sus funciones;
 *   2. en tipos: un archivo TypeScript que usa la API pública compila con `NodeNext` y con `Bundler`.
 *
 *   npm run build && npm run smoke
 *
 * Usa las mismas versiones de las dependencias que el repositorio, para probar la combinación
 * que realmente se verificó. Necesita red (instala desde el registro de npm).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = ['core', 'better-auth', 'express', 'testing'];
const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });

/**
 * La versión exacta que el repositorio tiene instalada de un paquete. Algunos (como
 * `@better-auth/core`) no quedan en la raíz sino dentro del paquete que los usa.
 */
const installed = (name) => {
  const where = ['', 'packages/better-auth/'].map(
    (dir) => `${root}${dir}node_modules/${name}/package.json`,
  );
  const found = where.find((file) => existsSync(file));
  if (found === undefined) throw new Error(`${name} is not installed (run npm install)`);
  return JSON.parse(readFileSync(found, 'utf8')).version;
};

const work = mkdtempSync(join(process.env.SMOKE_DIR ?? tmpdir(), 'axeda-smoke-'));
const keep = process.argv.includes('--keep');
console.log(`working in ${work}`);

try {
  // 1. Empaquetar.
  const tarballs = join(work, 'tarballs');
  mkdirSync(tarballs);
  const packed = PACKAGES.map((name) => {
    const [info] = JSON.parse(
      execSync(`npm pack --json --ignore-scripts --pack-destination "${tarballs}"`, {
        cwd: `${root}packages/${name}`,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    return join(tarballs, info.filename);
  });

  // 2. Un proyecto vacío que instala solo los tarballs y lo que sus guías piden.
  const project = join(work, 'project');
  mkdirSync(project);
  const external = [
    'better-auth',
    '@better-auth/core',
    'better-sqlite3',
    'express',
    '@types/express',
    '@types/node',
    'typescript',
    'vitest',
  ];
  // Sin un lockfile, npm elige la última versión de lo que se pida con un rango. Los adaptadores de
  // better-auth aceptan `@better-auth/core@^x`, y una versión más nueva del núcleo exige otro
  // `better-call` que el que fija este better-auth: npm 10 no lo resuelve y se cae con «Cannot read
  // properties of null (reading 'edgesOut')». Se fija la misma versión de @better-auth/core en todo
  // el árbol, la que el repositorio verificó.
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'axeda-smoke',
        private: true,
        type: 'module',
        overrides: { '@better-auth/core': installed('@better-auth/core') },
      },
      null,
      2,
    ),
  );
  // Sin scripts: better-sqlite3 trae su binario compilado, y así se prueba lo mismo en todos los sistemas.
  run(
    `npm install --ignore-scripts --no-audit --no-fund ${[
      ...packed,
      ...external.map((name) => `${name}@${installed(name)}`),
    ]
      .map((item) => `"${item}"`)
      .join(' ')}`,
    project,
  );

  // 3. En ejecución.
  writeFileSync(join(project, 'smoke.mjs'), readFileSync(`${root}scripts/smoke-run.mjs`, 'utf8'));
  run('node smoke.mjs', project);

  // 3b. Desde CommonJS (los paquetes son solo ESM): con import() y, si el Node lo admite, con require().
  mkdirSync(join(project, 'commonjs'));
  writeFileSync(join(project, 'commonjs', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(
    join(project, 'commonjs', 'smoke-cjs.cjs'),
    readFileSync(`${root}scripts/smoke-cjs.cjs`, 'utf8'),
  );
  run('node smoke-cjs.cjs', join(project, 'commonjs'));

  // 4. En tipos, con las dos resoluciones de módulos que usa la gente.
  writeFileSync(join(project, 'check.ts'), readFileSync(`${root}scripts/smoke-types.ts`, 'utf8'));
  for (const [module, resolution] of [
    ['NodeNext', 'NodeNext'],
    ['ESNext', 'Bundler'],
  ]) {
    writeFileSync(
      join(project, `tsconfig.${resolution}.json`),
      JSON.stringify({
        compilerOptions: {
          module,
          moduleResolution: resolution,
          target: 'ES2022',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        files: ['check.ts'],
      }),
    );
    console.log(`type-checking with moduleResolution ${resolution}`);
    run(`node node_modules/typescript/bin/tsc -p tsconfig.${resolution}.json`, project);
  }
  console.log('\nThe packed packages install, run and type-check in an empty project.');
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
