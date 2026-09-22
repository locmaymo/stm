import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };

/**
 * Every line the manager writes about itself, in both languages.
 *
 * A log line carries a code, and the console looks that code up in the
 * catalogue; a code with no entry falls back to the English the server sent.
 * That fallback is deliberate and right for output from SillyTavern, npm or
 * cloudflared - translating another project's output would make it impossible
 * to search for - but for a line this project wrote itself it is just a line
 * somebody cannot read.
 *
 * It is also invisible: nothing fails, the English simply shows through, and
 * the only way anybody finds out is by reading the log in Vietnamese and
 * meeting a sentence in English. Fifty-one of them had accumulated that way,
 * most of them the Cloudflare and R2 lines, which are exactly the ones read by
 * somebody whose backups are not working.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_ROOTS = ['apps', 'packages'];

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') continue;
      yield* sourceFiles(path);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      yield path;
    }
  }
}

function lookup(catalog: unknown, code: string): string | undefined {
  let current: unknown = catalog;
  for (const part of code.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

test('every log line the manager writes has an entry in both languages', async () => {
  const codes = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for await (const path of sourceFiles(join(ROOT, root))) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/logEvent\(\s*'([a-zA-Z0-9_.]+)'/gu)) codes.add(match[1]!);
    }
  }
  // A guard that finds nothing is a guard that has stopped working.
  assert.ok(codes.size > 100, `only ${codes.size} log codes were found; the scan is broken`);

  const missing = [...codes].filter((code) => lookup(en.logs, code) === undefined || lookup(vi.logs, code) === undefined).sort();
  assert.deepEqual(missing, [], `log codes with no entry in one of the catalogues:\n${missing.join('\n')}`);
});

test('a log line says the same thing in both languages, with the same values in it', () => {
  // The values are filled in by the console from what the server sent, so a
  // translation that drops one loses whatever it named - a port, a reason, a
  // path - and a translation that invents one shows the reader a literal
  // "{reason}" where a sentence should be.
  const walk = (english: unknown, vietnamese: unknown, path: string): void => {
    if (typeof english === 'string') {
      assert.equal(typeof vietnamese, 'string', `${path} is missing from the Vietnamese catalogue`);
      const names = (value: string): string[] => [...value.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!).sort();
      assert.deepEqual(names(vietnamese as string), names(english), `${path} does not fill in the same values in both languages`);
      return;
    }
    if (typeof english !== 'object' || english === null) return;
    for (const [key, value] of Object.entries(english)) walk(value, (vietnamese as Record<string, unknown> | null)?.[key], `${path}.${key}`);
  };
  walk(en.logs, vi.logs, 'logs');
});
