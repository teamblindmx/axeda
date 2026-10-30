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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = ['core', 'better-auth', 'express', 'testing'];
const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });

/** La versión exacta que el repositorio tiene instalada de un paquete. */
const installed = (name) =>
  JSON.parse(readFileSync(`${root}node_modules/${name}/package.json`, 'utf8')).version;

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
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'axeda-smoke', private: true, type: 'module' }, null, 2),
  );
  const external = [
    'better-auth',
    'better-sqlite3',
    'express',
    '@types/express',
    '@types/node',
    'typescript',
    'vitest',
  ].map((name) => `${name}@${installed(name)}`);
  // Sin scripts: better-sqlite3 trae su binario compilado, y así se prueba lo mismo en todos los sistemas.
  run(
    `npm install --ignore-scripts --no-audit --no-fund ${[...packed, ...external]
      .map((item) => `"${item}"`)
      .join(' ')}`,
    project,
  );

  // 3. En ejecución.
  writeFileSync(join(project, 'smoke.mjs'), readFileSync(`${root}scripts/smoke-run.mjs`, 'utf8'));
  run('node smoke.mjs', project);

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
