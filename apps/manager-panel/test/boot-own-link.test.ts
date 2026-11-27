import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

/** The page's own ask for the console's link, read out of the real file. */
function bootScript(): string {
  const script = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1] ?? '').find((body) => body.includes('/api/v1/setup/own-link'));
  assert.ok(script, 'index.html asks for the link before the bundle');
  return script;
}

/** Run it in a window that is or is not inside another page, and say what it asked for. */
function run(window: Record<string, unknown>): Array<{ url: string; method: string | undefined }> {
  const asked: Array<{ url: string; method: string | undefined }> = [];
  window.fetch = (url: string, init?: { method?: string }) => {
    asked.push({ url, method: init?.method });
    return Promise.resolve();
  };
  new Function('window', bootScript())(window);
  return asked;
}

test('a console inside another page asks for its own link before the bundle has loaded', () => {
  const top = {};
  const framed = { top } as Record<string, unknown>;
  framed.self = framed;
  assert.deepEqual(run(framed), [{ url: '/api/v1/setup/own-link', method: 'POST' }]);
});

test('a frame that may not look at its parent is still a frame', () => {
  const framed = {} as Record<string, unknown>;
  framed.self = framed;
  Object.defineProperty(framed, 'top', { get: () => { throw new Error('blocked'); } });
  assert.equal(run(framed).length, 1);
});

test('a console in a tab of its own asks for nothing', () => {
  const own = {} as Record<string, unknown>;
  own.self = own;
  own.top = own;
  assert.deepEqual(run(own), []);
});

test('a browser with no fetch still gets a page', () => {
  const framed = { top: {} } as Record<string, unknown>;
  framed.self = framed;
  assert.doesNotThrow(() => new Function('window', bootScript())(framed));
});
