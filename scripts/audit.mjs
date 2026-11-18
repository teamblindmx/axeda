/**
 * Auditoría de dependencias con excepciones que caducan.
 *
 *   node scripts/audit.mjs
 *   node scripts/audit.mjs --report <audit.json> --today 2026-11-17   (para las pruebas)
 *
 * Hace lo mismo que `npm audit --audit-level=high`: falla si hay un aviso alto o crítico. La única
 * diferencia es que respeta `scripts/audit-exceptions.json`, para el caso en que un aviso **no
 * tiene corrección publicada** y solo afecta a herramientas de desarrollo. Cada excepción nombra un
 * aviso concreto (su GHSA), dice por qué y caduca en una fecha: pasada esa fecha vuelve a fallar,
 * para que nadie la olvide. Una excepción que ya no hace falta se avisa para borrarla.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const BLOCKING = new Set(['high', 'critical']);

/** El informe de `npm audit --json`. npm sale con código 1 cuando encuentra algo: no es un fallo. */
function auditReport() {
  const file = option('--report');
  if (file !== undefined) return JSON.parse(readFileSync(file, 'utf8'));
  try {
    return JSON.parse(execSync('npm audit --json', { cwd: root, encoding: 'utf8' }));
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim().startsWith('{')) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

/** Los avisos de origen (no los paquetes que solo dependen de un vulnerable), por su GHSA. */
function advisoriesOf(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const id = String(via.url ?? via.source)
        .split('/')
        .at(-1);
      found.set(id, {
        id,
        package: via.name,
        severity: via.severity,
        title: via.title,
        url: via.url,
      });
    }
  }
  return [...found.values()];
}

const today = option('--today') ?? new Date().toISOString().slice(0, 10);
const exceptions = JSON.parse(
  readFileSync(option('--exceptions') ?? `${root}scripts/audit-exceptions.json`, 'utf8'),
);
const advisories = advisoriesOf(auditReport());
const blocking = advisories.filter((advisory) => BLOCKING.has(advisory.severity));

const problems = [];
for (const advisory of blocking) {
  const exception = exceptions.find((candidate) => candidate.id === advisory.id);
  if (exception === undefined) {
    problems.push(
      `${advisory.severity}: ${advisory.package} — ${advisory.title} (${advisory.url})`,
    );
  } else if (exception.expires < today) {
    problems.push(
      `${advisory.severity}: ${advisory.package} — the exception for ${advisory.id} expired on ${exception.expires}; ` +
        'update the dependency or review the exception',
    );
  } else {
    console.log(
      `allowed until ${exception.expires}: ${advisory.package} ${advisory.id} — ${exception.reason}`,
    );
  }
}
for (const exception of exceptions) {
  if (!blocking.some((advisory) => advisory.id === exception.id)) {
    console.log(
      `no longer needed: the exception for ${exception.id} (${exception.package}) can be removed`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Blocking advisories:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('No blocking advisories.');
