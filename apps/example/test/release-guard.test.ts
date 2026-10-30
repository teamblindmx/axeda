import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** La puerta que se niega a publicar algo que no está listo, probada con paquetes de mentira. */
const guard = fileURLToPath(new URL('../../../scripts/release-guard.mjs', import.meta.url));
const NAMES = ['core', 'better-auth', 'express', 'testing'] as const;
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: { access: string };
  dependencies?: Record<string, string>;
}

function repository(
  change: (manifests: Record<(typeof NAMES)[number], Manifest>) => void = () => {},
) {
  const manifests = Object.fromEntries(
    NAMES.map((name) => [
      name,
      {
        name: `@axeda/${name}`,
        version: '0.1.0-alpha.0',
        publishConfig: { access: 'public' },
        ...(name === 'core' ? {} : { dependencies: { '@axeda/core': '^0.1.0-alpha.0' } }),
      } satisfies Manifest,
    ]),
  ) as unknown as Record<(typeof NAMES)[number], Manifest>;
  change(manifests);
  const root = mkdtempSync(join(tmpdir(), 'axeda-release-'));
  folders.push(root);
  for (const name of NAMES) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify(manifests[name]));
  }
  return root;
}

function run(root: string, tag = 'alpha') {
  const result = spawnSync(process.execPath, [guard, '--root', root, '--tag', tag], {
    encoding: 'utf8',
  });
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
}

describe('the release guard', () => {
  it('lets a consistent alpha through', () => {
    const { status, text } = run(repository());
    expect(status, text).toBe(0);
    expect(text).toContain('@axeda/core@0.1.0-alpha.0');
  });

  it('accepts a later alpha of the same version for the range the packages ask for', () => {
    const { status, text } = run(
      repository((m) => {
        for (const name of NAMES) m[name].version = '0.1.0-alpha.3';
      }),
    );
    expect(status, text).toBe(0);
  });

  it('refuses private packages', () => {
    const { status, text } = run(
      repository((m) => {
        m.core.private = true;
      }),
    );
    expect(status).toBe(1);
    expect(text).toContain('@axeda/core is still private');
  });

  it('refuses version 0.0.0', () => {
    const { status, text } = run(
      repository((m) => {
        for (const name of NAMES) m[name].version = '0.0.0';
      }),
    );
    expect(status).toBe(1);
    expect(text).toContain('still at version 0.0.0');
  });

  it('refuses a version that does not match the tag', () => {
    const stable = repository((m) => {
      for (const name of NAMES) {
        m[name].version = '0.1.0';
        if (m[name].dependencies) m[name].dependencies = { '@axeda/core': '^0.1.0' };
      }
    });
    const alpha = run(stable, 'alpha');
    expect(alpha.status).toBe(1);
    expect(alpha.text).toContain('does not look like a "alpha" pre-release');
    expect(run(stable, 'latest').status).toBe(0);
  });

  it.each(['alpha; echo hacked', 'ALPHA', '$(whoami)', '', '-x'])(
    'refuses a dist-tag that is not a plain word: %j',
    (tag) => {
      const { status, text } = run(repository(), tag);
      expect(status).toBe(1);
      expect(text).toContain('is not a valid dist-tag');
    },
  );

  it('refuses a pre-release going to latest', () => {
    const { status, text } = run(repository(), 'latest');
    expect(status).toBe(1);
    expect(text).toContain('is a pre-release but is going to the "latest" tag');
  });

  it('refuses packages with different versions', () => {
    const { status, text } = run(
      repository((m) => {
        m.express.version = '0.1.0-alpha.1';
      }),
    );
    expect(status).toBe(1);
    expect(text).toContain('different versions');
  });

  it('refuses a dependency on @axeda/core that the published version does not satisfy', () => {
    const { status, text } = run(
      repository((m) => {
        for (const name of NAMES) m[name].version = '0.2.0-alpha.0';
      }),
    );
    expect(status).toBe(1);
    expect(text).toContain('asks for @axeda/core ^0.1.0-alpha.0');
  });

  it('refuses a package that would publish privately', () => {
    const { status, text } = run(
      repository((m) => {
        delete m.testing.publishConfig;
      }),
    );
    expect(status).toBe(1);
    expect(text).toContain('@axeda/testing has no publishConfig.access: public');
  });
});
