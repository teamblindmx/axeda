import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'axeda-sbom-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

interface Component {
  name: string;
  version: string;
  purl: string;
  licenses: Array<{ license: { id: string } }>;
  hashes: Array<{ alg: string; content: string }>;
}
interface Sbom {
  bomFormat: string;
  specVersion: string;
  metadata: { component: { name: string; version: string } };
  components: Component[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
  properties: Array<{ name: string; value: string }>;
}

execFileSync(process.execPath, [join(root, 'scripts/sbom.mjs'), '--out', out], { stdio: 'ignore' });
const read = (name: string) =>
  JSON.parse(readFileSync(join(out, `${name}.cdx.json`), 'utf8')) as Sbom;
const installed = (name: string) =>
  JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as {
    version: string;
    license: string;
  };

describe('the SBOM of each published package', () => {
  it('is a CycloneDX document that names the package', () => {
    for (const name of ['core', 'better-auth', 'express', 'testing']) {
      const sbom = read(name);
      expect(sbom.bomFormat).toBe('CycloneDX');
      expect(sbom.specVersion).toBe('1.5');
      expect(sbom.metadata.component.name).toBe(`@axeda/${name}`);
    }
  });

  it('lists zod with its real version, licence and lockfile hash where the code uses it', () => {
    const zod = installed('zod');
    for (const name of ['core', 'better-auth']) {
      const sbom = read(name);
      expect(sbom.components.map((c) => `${c.name}@${c.version}`)).toEqual([`zod@${zod.version}`]);
      const [component] = sbom.components;
      expect(component?.licenses).toEqual([{ license: { id: zod.license } }]);
      expect(component?.hashes[0]?.alg).toBe('SHA-512');
      expect(component?.hashes[0]?.content).toMatch(/^[0-9a-f]{128}$/);
      expect(component?.purl).toBe(`pkg:npm/zod@${zod.version}`);
      expect(sbom.dependencies[0]?.dependsOn).toEqual([`pkg:npm/zod@${zod.version}`]);
    }
  });

  it('has no third-party runtime dependencies where there are none', () => {
    expect(read('express').components).toEqual([]);
    expect(read('testing').components).toEqual([]);
  });

  it('leaves out development tools, the packages themselves and anything without a licence', () => {
    for (const name of ['core', 'better-auth', 'express', 'testing']) {
      for (const component of read(name).components) {
        expect(component.name).not.toMatch(/^(@axeda\/|vitest|typescript|eslint|prettier|tsx)/);
        expect(component.licenses.length).toBeGreaterThan(0);
      }
    }
  });

  it('records what the installer must provide as peers, without versioning it', () => {
    const peers = read('better-auth').properties.map((p) => p.name);
    expect(peers).toEqual(['axeda:peer:@better-auth/core', 'axeda:peer:better-auth']);
    expect(read('express').properties.map((p) => p.name)).toContain('axeda:peer:express');
    expect(read('testing').properties.map((p) => p.name)).toContain('axeda:peer:vitest');
  });
});
