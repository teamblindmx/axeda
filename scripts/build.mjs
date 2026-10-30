/**
 * Compila los cuatro paquetes a `dist/` (JavaScript ESM + declaraciones), en orden de dependencias:
 * `core` primero, porque los demás resuelven `@axeda/core` contra su `dist`, no contra el código fuente.
 */
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ORDER = ['core', 'better-auth', 'express', 'testing'];
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

for (const name of ORDER) {
  const dir = `${root}packages/${name}`;
  rmSync(`${dir}/dist`, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [tsc, '-p', `${dir}/tsconfig.build.json`], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`Build failed: @axeda/${name}`);
    process.exit(result.status ?? 1);
  }
  console.log(`built @axeda/${name}`);
}
