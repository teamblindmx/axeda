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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  const versions = external.map((name) => [name, installed(name)]);
  // Sin un lockfile, npm elige la última versión de todo lo que llegue con un rango, así que lo que
  // se publique mañana puede romper la instalación aunque aquí no cambie nada (pasó con Better Auth:
  // un @better-auth/core nuevo exigía otro better-call y npm 10 se caía con «edgesOut»). Para probar
  // la combinación que el repositorio verificó, se resuelve todo como estaba el día en que salió la
  // más reciente de las versiones fijadas (`--before`), y @better-auth/core se fija en todo el árbol.
  const published = versions.map(([name, version]) => {
    const times = JSON.parse(
      execSync(`npm view "${name}" time --json`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    );
    return new Date(times[version]).getTime();
  });
  const before = new Date(Math.max(...published) + 24 * 60 * 60 * 1000).toISOString();
  console.log(`resolving dependencies as of ${before}`);
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
  const logs = join(work, 'npm-logs');
  try {
    run(
      `npm install --ignore-scripts --no-audit --no-fund --before="${before}" --logs-dir="${logs}" ${[
        ...packed,
        ...versions.map(([name, version]) => `${name}@${version}`),
      ]
        .map((item) => `"${item}"`)
        .join(' ')}`,
      project,
    );
  } catch (error) {
    // El CI no guarda el registro de npm: se imprime el final, que es donde está la causa.
    for (const file of existsSync(logs) ? readdirSync(logs) : []) {
      const lines = readFileSync(join(logs, file), 'utf8').trimEnd().split('\n');
      console.error(`\n--- ${file} (last 80 lines) ---\n${lines.slice(-80).join('\n')}`);
    }
    throw error;
  }

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
