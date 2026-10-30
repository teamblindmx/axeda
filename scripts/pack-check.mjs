/**
 * Comprueba lo que se publicaría de cada paquete (`npm pack --dry-run`), sin publicar nada.
 *
 *   npm run build && npm run pack:check
 *
 * Falla si: falta algo que debe estar (dist, README, LICENSE, NOTICE, lo que nombra `exports`),
 * entra algo que no debe (fuentes, pruebas, mapas, configuración), la LICENSE o el NOTICE difieren
 * de los de la raíz, una dependencia interna usa un protocolo que npm no publica, o el tamaño
 * supera su presupuesto (scripts/pack-budgets.json).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = ['core', 'better-auth', 'express', 'testing'];
const budgets = JSON.parse(readFileSync(`${root}scripts/pack-budgets.json`, 'utf8'));

const FORBIDDEN = [
  [/^(src|test|tests|bench|scripts|apps|docs|examples)\//, 'source, tests or repository folders'],
  [/\.test\.[cm]?[jt]s$/, 'a test file'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'a TypeScript config'],
  [/\.tsbuildinfo$/, 'a build cache'],
  [/\.map$/, 'a source map (the sources are not published)'],
  [/(^|\/)\.env/, 'an environment file'],
  [/(^|\/)(\.git|node_modules)\//, 'repository or dependency folders'],
];
const ALWAYS = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];

const kb = (bytes) => bytes / 1024;

/** Todas las rutas de archivo que nombran `main`, `types` y `exports`. */
function referencedFiles(json) {
  const found = new Set([json.main, json.types].filter(Boolean));
  const walk = (value) => {
    if (typeof value === 'string') found.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(json.exports);
  return [...found].map((path) => path.replace(/^\.\//, ''));
}

function tarball(dir) {
  const [packed] = JSON.parse(
    execSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  return packed;
}

/** Lo que debe y lo que no debe estar en la lista de archivos. */
function contentProblems(files, json) {
  const problems = [];
  for (const required of [...ALWAYS, ...referencedFiles(json)]) {
    if (!files.includes(required)) problems.push(`missing from the tarball: ${required}`);
  }
  for (const file of files) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(file)) problems.push(`must not be published: ${file} (${why})`);
    }
    if (/\.ts$/.test(file) && !/\.d\.ts$/.test(file)) {
      problems.push(`raw TypeScript published: ${file}`);
    }
  }
  return problems;
}

/** La LICENSE y el NOTICE de cada paquete son los de la raíz. */
function legalProblems(dir) {
  return ['LICENSE', 'NOTICE'].flatMap((legal) =>
    readFileSync(`${dir}/${legal}`, 'utf8') === readFileSync(`${root}${legal}`, 'utf8')
      ? []
      : [`${legal} differs from the one at the repository root`],
  );
}

/** Metadatos que npm necesita y dependencias que npm sabe publicar. */
function manifestProblems(json) {
  const problems = [];
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(json[section] ?? {})) {
      if (/^(workspace|file|link|git)/.test(range))
        problems.push(`${section}.${dep} uses "${range}"`);
    }
  }
  if (json.license !== 'Apache-2.0') problems.push(`license is "${json.license}"`);
  if (json.type !== 'module') problems.push('package is not "type": "module"');
  return problems;
}

function sizeProblems(stats, budget) {
  const problems = [];
  if (stats.packedKB > budget.packedKB) {
    problems.push(
      `packed size ${stats.packedKB.toFixed(1)} KB exceeds its budget of ${budget.packedKB} KB`,
    );
  }
  if (stats.unpackedKB > budget.unpackedKB) {
    problems.push(
      `unpacked size ${stats.unpackedKB.toFixed(1)} KB exceeds its budget of ${budget.unpackedKB} KB`,
    );
  }
  return problems;
}

function checkPackage(name) {
  const dir = `${root}packages/${name}`;
  const json = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  if (!existsSync(`${dir}/dist/index.js`)) {
    return { problems: ['dist/ is missing: run `npm run build` first'], stats: null };
  }
  const packed = tarball(dir);
  const stats = {
    files: packed.files.length,
    packedKB: kb(packed.size),
    unpackedKB: kb(packed.unpackedSize),
  };
  const problems = [
    ...contentProblems(
      packed.files.map((file) => file.path),
      json,
    ),
    ...legalProblems(dir),
    ...manifestProblems(json),
    ...sizeProblems(stats, budgets[name]),
  ];
  return { problems, stats };
}

let failed = false;
console.log(
  'package'.padEnd(22),
  'files'.padStart(6),
  'packed KB'.padStart(11),
  'unpacked KB'.padStart(13),
);
for (const name of PACKAGES) {
  const { problems, stats } = checkPackage(name);
  if (stats) {
    console.log(
      `@teamblind/axeda-${name}`.padEnd(22),
      String(stats.files).padStart(6),
      stats.packedKB.toFixed(1).padStart(11),
      stats.unpackedKB.toFixed(1).padStart(13),
    );
  }
  for (const problem of problems) console.error(`  ✘ @teamblind/axeda-${name}: ${problem}`);
  if (problems.length > 0) failed = true;
}
if (failed) process.exit(1);
console.log('\nEvery package contains what it should and nothing else.');
