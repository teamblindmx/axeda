import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** La auditoría con excepciones que caducan, probada con informes de mentira. */
const gate = fileURLToPath(new URL('../../../scripts/audit.mjs', import.meta.url));
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const advisory = (id: string, name: string, severity: string) => ({
  name,
  severity,
  title: `${name} is vulnerable`,
  url: `https://github.com/advisories/${id}`,
});

/** Un informe con la forma de `npm audit --json`: un vulnerable de origen y uno que solo depende de él. */
const report = (...origins: ReturnType<typeof advisory>[]) => ({
  vulnerabilities: Object.fromEntries([
    ...origins.map((origin) => [origin.name, { name: origin.name, via: [origin] }]),
    ['dependent', { name: 'dependent', via: origins.map((origin) => origin.name) }],
  ]),
});

const EXCEPTION = {
  id: 'GHSA-aaaa-bbbb-cccc',
  package: 'picomatch',
  reason: 'no fix yet, development only',
  expires: '2026-12-17',
};

function run(auditReport: unknown, exceptions: unknown[], today: string) {
  const folder = mkdtempSync(join(tmpdir(), 'axeda-audit-'));
  folders.push(folder);
  writeFileSync(join(folder, 'report.json'), JSON.stringify(auditReport));
  writeFileSync(join(folder, 'exceptions.json'), JSON.stringify(exceptions));
  const result = spawnSync(
    process.execPath,
    [
      gate,
      '--report',
      join(folder, 'report.json'),
      '--exceptions',
      join(folder, 'exceptions.json'),
      '--today',
      today,
    ],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the dependency audit gate', () => {
  it('lets an excepted advisory through until its exception expires', () => {
    const vulnerable = report(advisory(EXCEPTION.id, 'picomatch', 'high'));
    const before = run(vulnerable, [EXCEPTION], '2026-12-17');
    expect(before.status).toBe(0);
    expect(before.output).toContain('allowed until 2026-12-17');

    const after = run(vulnerable, [EXCEPTION], '2026-12-18');
    expect(after.status).toBe(1);
    expect(after.output).toContain('expired on 2026-12-17');
  });

  it('fails on any other high or critical advisory', () => {
    for (const severity of ['high', 'critical']) {
      const result = run(
        report(
          advisory(EXCEPTION.id, 'picomatch', 'high'),
          advisory('GHSA-zzzz-zzzz-zzzz', 'other', severity),
        ),
        [EXCEPTION],
        '2026-11-17',
      );
      expect(result.status, severity).toBe(1);
      expect(result.output).toContain('other is vulnerable');
    }
  });

  it('does not block on moderate or low advisories, like npm audit --audit-level=high', () => {
    const result = run(
      report(advisory('GHSA-mmmm-mmmm-mmmm', 'minimatch', 'moderate')),
      [],
      '2026-11-17',
    );
    expect(result.status).toBe(0);
  });

  it('says when an exception is no longer needed', () => {
    const result = run(report(), [EXCEPTION], '2026-11-17');
    expect(result.status).toBe(0);
    expect(result.output).toContain('no longer needed');
  });
});
