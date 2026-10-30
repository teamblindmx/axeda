/**
 * Inventario de componentes (SBOM, CycloneDX 1.5) de lo que cada paquete publicado necesita para
 * ejecutarse: sus dependencias de producción y las de estas, con versión, licencia y huella del
 * lockfile. Las dependencias de desarrollo no entran: no se instalan al usar los paquetes.
 *
 *   npm run sbom                      escribe sbom/<paquete>.cdx.json
 *   npm run sbom -- --out otra/ruta
 *
 * (`npm sbom --workspace` omite dependencias directas de un espacio de trabajo, así que no se usa.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = ['core', 'better-auth', 'express', 'testing'];
const lock = JSON.parse(readFileSync(`${root}package-lock.json`, 'utf8'));

/** Resuelve un paquete como lo hace Node: subiendo por las carpetas `node_modules`. */
function resolveFrom(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** Dependencias de producción transitivas de `dir`, sin repetir. */
function productionClosure(dir) {
  const found = new Map();
  const visit = (name, from) => {
    const location = resolveFrom(name, from);
    if (location === null) throw new Error(`${name} is not installed (run npm install)`);
    const json = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
    const key = `${json.name}@${json.version}`;
    if (found.has(key)) return;
    found.set(key, { json, location });
    for (const dependency of Object.keys(json.dependencies ?? {})) visit(dependency, location);
  };
  const own = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(own.dependencies ?? {})) {
    if (!dependency.startsWith('@teamblind/axeda-')) visit(dependency, dir);
  }
  return [...found.values()];
}

const purl = (name, version) => `pkg:npm/${name.replace('@', '%40')}@${version}`;

/** La huella `integrity` (sha512) que fijó el lockfile, si la hay. */
function integrityOf(location) {
  const key = location.slice(root.length).replaceAll('\\', '/');
  const entry = lock.packages?.[key];
  const match = /^sha512-(.+)$/.exec(entry?.integrity ?? '');
  return match
    ? [{ alg: 'SHA-512', content: Buffer.from(match[1], 'base64').toString('hex') }]
    : [];
}

function sbomFor(name) {
  const dir = `${root}packages/${name}`;
  const own = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const closure = productionClosure(dir);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'library',
        'bom-ref': purl(own.name, own.version),
        name: own.name,
        version: own.version,
        licenses: [{ license: { id: own.license } }],
        purl: purl(own.name, own.version),
      },
    },
    components: closure.map(({ json, location }) => ({
      type: 'library',
      'bom-ref': purl(json.name, json.version),
      name: json.name,
      version: json.version,
      purl: purl(json.name, json.version),
      licenses: json.license ? [{ license: { id: json.license } }] : [],
      hashes: integrityOf(location),
    })),
    dependencies: [
      {
        ref: purl(own.name, own.version),
        dependsOn: closure.map(({ json }) => purl(json.name, json.version)),
      },
    ],
    // Lo que el paquete espera que ponga quien lo instala: no se incluye ni se versiona aquí.
    properties: Object.entries(own.peerDependencies ?? {}).map(([peer, range]) => ({
      name: `axeda:peer:${peer}`,
      value: range,
    })),
  };
}

const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : `${root}sbom`;
mkdirSync(out, { recursive: true });
for (const name of PACKAGES) {
  const document = sbomFor(name);
  writeFileSync(join(out, `${name}.cdx.json`), `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `${document.metadata.component.name}: ${document.components.length} third-party component(s)` +
      (document.components.length > 0
        ? ` (${document.components.map((c) => `${c.name}@${c.version}`).join(', ')})`
        : ''),
  );
}
