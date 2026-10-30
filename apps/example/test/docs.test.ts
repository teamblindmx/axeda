import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MAPPED_CODES, axeda } from '@teamblind/axeda-better-auth';
import { AXEDA_PERMISSIONS, resolveOptions } from '@teamblind/axeda-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = resolve(ROOT, 'docs');
const LANGUAGES = ['en', 'es'] as const;

const FILES = [
  'README.md',
  'asvs.md',
  'concepts.md',
  'express.md',
  'quickstart.md',
  'reference.md',
  'security.md',
  'testing.md',
];
const read = (language: string, file: string) =>
  readFileSync(resolve(DOCS, language, file), 'utf8');

/** Los bloques de código con su lenguaje. */
function fences(markdown: string): Array<{ language: string; code: string }> {
  return [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map((match) => ({
    language: match[1] ?? '',
    code: match[2] ?? '',
  }));
}

describe('the documentation is complete and in both languages', () => {
  it('has the same files in English and Spanish, and nothing else', () => {
    for (const language of LANGUAGES) {
      expect(readdirSync(resolve(DOCS, language)).sort(), language).toEqual([...FILES].sort());
    }
  });

  it('keeps both languages in step: same headings, code blocks and table rows', () => {
    for (const file of FILES) {
      const [en, es] = LANGUAGES.map((language) => read(language, file));
      const count = (text: string | undefined, pattern: RegExp) =>
        (text?.match(pattern) ?? []).length;
      expect(count(es, /^#{1,3} /gm), `${file}: headings`).toBe(count(en, /^#{1,3} /gm));
      expect(count(es, /^```/gm), `${file}: code fences`).toBe(count(en, /^```/gm));
      expect(count(es, /^\|/gm), `${file}: table rows`).toBe(count(en, /^\|/gm));
      expect(
        fences(es ?? '').map((f) => f.language),
        `${file}: languages`,
      ).toEqual(fences(en ?? '').map((f) => f.language));
    }
  });

  it('every relative link points at something that exists', () => {
    for (const language of LANGUAGES) {
      for (const file of FILES) {
        const text = read(language, file);
        for (const match of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
          const target = (match[1] ?? '').split('#')[0] ?? '';
          const path = resolve(DOCS, language, target);
          expect(existsSync(path), `${language}/${file} → ${target}`).toBe(true);
        }
      }
    }
  });

  it('every TypeScript block is valid syntax', () => {
    for (const language of LANGUAGES) {
      for (const file of FILES) {
        for (const { language: lang, code } of fences(read(language, file))) {
          if (lang !== 'ts') continue;
          const result = ts.transpileModule(code, {
            reportDiagnostics: true,
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          });
          const problems = (result.diagnostics ?? []).map((d) =>
            ts.flattenDiagnosticMessageText(d.messageText, ' '),
          );
          expect(problems, `${language}/${file}:\n${code}`).toEqual([]);
        }
      }
    }
  });
});

describe('the ASVS register cites evidence that exists', () => {
  const testFiles = (): Set<string> => {
    const found = new Set<string>();
    for (const base of ['packages', 'apps']) {
      for (const entry of readdirSync(resolve(ROOT, base), { withFileTypes: true })) {
        const dir = resolve(ROOT, base, entry.name, 'test');
        if (entry.isDirectory() && existsSync(dir)) {
          for (const file of readdirSync(dir)) found.add(file);
        }
      }
    }
    return found;
  };

  it.each(LANGUAGES)('%s: every test file it names is in the repository', (language) => {
    const cited = new Set(
      [...read(language, 'asvs.md').matchAll(/`([\w.-]+\.test\.ts)`/g)].map((match) => match[1]),
    );
    expect(cited.size).toBeGreaterThan(10);
    const available = testFiles();
    for (const name of cited) expect(available.has(name ?? ''), `${language}: ${name}`).toBe(true);
  });

  it.each(LANGUAGES)('%s: the summary counts match the rows', (language) => {
    const text = read(language, 'asvs.md');
    const [, summary = ''] = text.split(/^## (?:Summary|Resumen)$/m);
    const table = summary.split(/^## /m)[0] ?? '';
    const total = [...table.matchAll(/\|\s*([A-Za-z ]+?)\s*\|\s*(\d+)\s*\|/g)]
      .map((match) => Number(match[2]))
      .reduce((a, b) => a + b, 0);
    const rows = [...text.matchAll(/^\| (V\d+[^|]*)\|/gm)].length;
    expect(total).toBe(rows);
    expect(rows).toBeGreaterThan(80);
  });
});

describe('the reference matches the code', () => {
  const plugin = axeda({ permissions: [] });
  const endpoints = Object.values(plugin.endpoints).map((endpoint) => ({
    path: endpoint.path as string,
    method: (endpoint.options as { method: string }).method,
  }));

  it.each(LANGUAGES)(
    '%s: documents every endpoint, with its method, and no stale ones',
    (language) => {
      const reference = read(language, 'reference.md');
      for (const { path, method } of endpoints) {
        const row = new RegExp(`\\|\\s*${method}\\s*\\|\\s*\`${path}\`\\s*\\|`);
        expect(reference, `${method} ${path}`).toMatch(row);
      }
      const documented = [...reference.matchAll(/^\|\s*(GET|POST)\s*\|\s*`(\/axeda\/[^`]+)`/gm)];
      expect(documented.length).toBe(endpoints.length);
    },
  );

  it.each(LANGUAGES)('%s: documents every error code the API can return', (language) => {
    const reference = read(language, 'reference.md');
    for (const code of MAPPED_CODES) {
      // Los de configuración nunca llegan al cliente como tales; la guía lo dice.
      expect(reference, code).toContain(`\`${code}\``);
    }
    for (const code of [
      'AXEDA_USER_BANNED',
      'AXEDA_INTERNAL_ERROR',
      'AXEDA_UNAUTHENTICATED',
      'AXEDA_NOT_FOUND',
      'AXEDA_CROSS_SITE',
    ]) {
      expect(reference, code).toContain(`\`${code}\``);
    }
  });

  it.each(LANGUAGES)('%s: explains every permission Axeda defines', (language) => {
    const concepts = read(language, 'concepts.md');
    for (const permission of Object.values(AXEDA_PERMISSIONS)) {
      expect(concepts, permission).toContain(`\`${permission}\``);
    }
  });

  it.each(LANGUAGES)('%s: states the real defaults', (language) => {
    const reference = read(language, 'reference.md');
    const { retention, invitations, limits } = resolveOptions({ permissions: [] });
    for (const value of [
      retention.graceDays,
      invitations.ttlHours,
      invitations.maxRoles,
      limits.maxAssignmentsPerUser,
      limits.maxPermissionsPerRole,
      limits.maxCachedUsers,
    ]) {
      expect(reference).toContain(`\`${value}\``);
    }
  });
});
