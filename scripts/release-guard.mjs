/**
 * Última puerta antes de `npm publish`: se niega si los paquetes no están listos para publicarse.
 *
 *   node scripts/release-guard.mjs --tag alpha
 *   node scripts/release-guard.mjs --tag alpha --root <carpeta>      (para las pruebas)
 *
 * Comprueba, en los cuatro paquetes:
 *   - que ya no son `private` (mientras lo sean, publicar falla; es la señal de que falta la decisión
 *     del nombre y de la organización de npm);
 *   - que la versión no es `0.0.0` y que cuadra con la etiqueta (`alpha` exige `-alpha.N`);
 *   - que todos llevan la misma versión (se publican juntos);
 *   - que `@teamblind/axeda-core` que piden los demás incluye la versión que se va a publicar;
 *   - que traen `publishConfig.access: public`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['core', 'better-auth', 'express', 'testing'];
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const root = option('--root') ?? fileURLToPath(new URL('..', import.meta.url));
const tag = option('--tag') ?? 'latest';

/** [mayor, menor, parche] y, si la hay, la parte previa (`alpha.3`). */
function split(text) {
  const [core, pre] = text.split(/-(.+)/);
  return { numbers: core.split('.').map(Number), pre: pre ?? null };
}

/** ¿Es la parte previa `a` igual o posterior a `b` (`alpha.3` frente a `alpha.0`)? */
function prereleaseAtLeast(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  for (const [index, y] of right.entries()) {
    const x = left[index];
    if (x === undefined) return false;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    return numeric ? Number(x) > Number(y) : x > y;
  }
  return true;
}

/** El mínimo que fija un rango `^` según npm: en 0.x el menor (o el parche) también manda. */
function caretAllows([major, minor, patch], [rMajor, rMinor, rPatch]) {
  if (major !== rMajor) return false;
  if (major === 0 && minor !== rMinor) return false;
  if (major === 0 && minor === 0 && patch !== rPatch) return false;
  return minor > rMinor || (minor === rMinor && patch >= rPatch);
}

/**
 * ¿Cumple `version` el rango `^x.y.z` o `x.y.z` (con o sin parte previa) que usan nuestras
 * dependencias internas? Una versión previa solo cumple un rango que nombra la misma base y una
 * parte previa igual o anterior, como hace npm.
 */
function satisfies(version, range) {
  if (!range.startsWith('^')) return version === range;
  const have = split(version);
  const want = split(range.slice(1));
  if (have.pre !== null) {
    const sameBase = have.numbers.join('.') === want.numbers.join('.');
    if (!sameBase || want.pre === null || !prereleaseAtLeast(have.pre, want.pre)) return false;
  }
  return caretAllows(have.numbers, want.numbers);
}

const problems = [];
if (!/^[a-z][a-z0-9-]*$/.test(tag)) problems.push(`"${tag}" is not a valid dist-tag`);
const manifests = PACKAGES.map((name) => ({
  name,
  json: JSON.parse(readFileSync(`${root}/packages/${name}/package.json`, 'utf8')),
}));

for (const { json } of manifests) {
  if (json.private === true) problems.push(`${json.name} is still private`);
  if (json.version === '0.0.0') problems.push(`${json.name} is still at version 0.0.0`);
  if (tag !== 'latest' && !json.version.includes(`-${tag}.`)) {
    problems.push(
      `${json.name}@${json.version} does not look like a "${tag}" pre-release (expected -${tag}.N)`,
    );
  }
  if (tag === 'latest' && json.version.includes('-')) {
    problems.push(`${json.name}@${json.version} is a pre-release but is going to the "latest" tag`);
  }
  if (json.publishConfig?.access !== 'public')
    problems.push(`${json.name} has no publishConfig.access: public`);
}

const versions = new Set(manifests.map(({ json }) => json.version));
if (versions.size > 1)
  problems.push(`the packages have different versions: ${[...versions].join(', ')}`);

const core = manifests.find(({ name }) => name === 'core')?.json;
for (const { json } of manifests) {
  const range = json.dependencies?.['@teamblind/axeda-core'];
  if (
    json.name !== '@teamblind/axeda-core' &&
    core &&
    range !== undefined &&
    !satisfies(core.version, range)
  ) {
    problems.push(
      `${json.name} asks for @teamblind/axeda-core ${range}, which ${core.version} does not satisfy`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `Not ready to publish (tag "${tag}"):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `Ready to publish ${manifests.map(({ json }) => `${json.name}@${json.version}`).join(', ')} with tag "${tag}".`,
);
