// Se ejecuta DENTRO del proyecto vacío de `scripts/smoke.mjs`, pero como CommonJS: la forma en que
// lo usaría un proyecto que todavía no es de módulos ES. Los paquetes son solo ESM.
const assert = require('node:assert/strict');

const ENTRIES = [
  ['@teamblind/axeda-core', 'createAxeda'],
  ['@teamblind/axeda-better-auth', 'axeda'],
  ['@teamblind/axeda-better-auth/client', 'axedaClient'],
  ['@teamblind/axeda-express', 'createAxedaExpress'],
  ['@teamblind/axeda-testing', 'createMemoryPersistence'],
];

async function main() {
  // 1. `import()` dinámico: funciona en cualquier Node 22. Es la forma que recomienda la guía.
  for (const [name, exported] of ENTRIES) {
    const module_ = await import(name);
    assert.equal(
      typeof module_[exported],
      'function',
      `${name} exports ${exported} through import()`,
    );
  }
  console.log('  ✔ every entry point loads from CommonJS with import()');

  // 2. `require()` de un módulo ES: sin bandera desde Node 22.12.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    console.log(
      `  - require() of ES modules needs Node 22.12 or later (this is ${process.versions.node}); skipped`,
    );
    return;
  }
  for (const [name, exported] of ENTRIES.filter(
    ([entry]) => entry !== '@teamblind/axeda-testing',
  )) {
    assert.equal(
      typeof require(name)[exported],
      'function',
      `${name} exports ${exported} through require()`,
    );
  }
  console.log('  ✔ and with require() on Node 22.12 or later');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
