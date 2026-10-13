import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { Installation } from '../../../packages/contracts/src/index.js';
import { BROKE_WINDOW_MS, BrokenAnnouncer, brokeAfter, ExtensionErrorStore, lastVersionChange, parseErrorReport, pluginFailure } from '../src/extension-errors.js';
import { ERRORS_REPORT_PATH, ERRORS_SCRIPT } from '../src/gateway-errors.js';

const EXTENSION_FILE = 'http://127.0.0.1:8001/scripts/extensions/third-party/Quick-Notes/index.js';

/**
 * SillyTavern's page as far as the error script can tell: a window to listen
 * on, a console to wrap, and a fetch that only records what it was asked.
 */
function page(): { context: object; sent: Array<Record<string, unknown>>; fire: (type: string, event: object) => void; logged: unknown[][] } {
  const listeners = new Map<string, Array<(event: object) => void>>();
  const sent: Array<Record<string, unknown>> = [];
  const logged: unknown[][] = [];
  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: object) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  const context = createContext({
    window,
    console: { error: (...args: unknown[]) => { logged.push(args); } },
    fetch: (url: string, init: { body: string; headers: Record<string, string> }) => {
      assert.equal(url, ERRORS_REPORT_PATH);
      assert.equal(init.headers['x-stm-tools'], '1');
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve();
    },
  });
  runInContext(ERRORS_SCRIPT, context, { filename: 'http://127.0.0.1:8001/__stm/extension-errors.js' });
  return { context, sent, logged, fire: (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event); } };
}

test('an error thrown from an extension’s file is reported as that extension’s, and SillyTavern’s own are not', () => {
  const { sent, fire } = page();
  fire('error', { message: 'Uncaught TypeError: x is undefined', filename: EXTENSION_FILE, lineno: 42, error: null });
  fire('error', { message: 'Uncaught TypeError: y', filename: 'http://127.0.0.1:8001/script.js', lineno: 7, error: { stack: 'at http://127.0.0.1:8001/script.js:7:1' } });
  assert.deepEqual(sent, [{ name: 'Quick-Notes', message: 'Uncaught TypeError: x is undefined', file: '/scripts/extensions/third-party/Quick-Notes/index.js', line: 42 }]);
});

test('the stack names the extension when the file the browser gives does not', () => {
  const { sent, fire } = page();
  fire('error', { message: 'boom', filename: 'http://127.0.0.1:8001/lib.js', lineno: 1, error: { message: 'boom', stack: `Error: boom\n    at render (${EXTENSION_FILE}:10:5)\n    at http://127.0.0.1:8001/lib.js:1:1` } });
  fire('unhandledrejection', { reason: { message: 'failed to fetch', stack: `Error: failed to fetch\n    at load (http://127.0.0.1:8001/scripts/extensions/third-party/My%20Tools/main.js:3:9)` } });
  assert.deepEqual(sent.map((report) => [report.name, report.message]), [['Quick-Notes', 'boom'], ['My Tools', 'failed to fetch']]);
});

test('an extension’s script that failed to load is reported', () => {
  const { sent, fire } = page();
  fire('error', { target: { src: EXTENSION_FILE } });
  assert.equal(sent[0]?.name, 'Quick-Notes');
  assert.match(String(sent[0]?.message), /^Could not load /u);
});

test('console.error from an extension is reported and still logged; from anywhere else it is only logged', () => {
  const { context, sent, logged } = page();
  runInContext('console.error("Quick Notes could not save", { code: 5 });', context, { filename: EXTENSION_FILE });
  runInContext('console.error("SillyTavern itself complains");', context, { filename: 'http://127.0.0.1:8001/script.js' });
  assert.deepEqual(sent.map((report) => [report.name, report.message, report.file]), [['Quick-Notes', 'Quick Notes could not save {"code":5}', '/scripts/extensions/third-party/Quick-Notes/index.js']]);
  assert.equal(logged.length, 2, 'the page’s own console still gets every line');
});

test('a page says at most ten things about one extension, and never more than 300 characters each', () => {
  const { sent, fire } = page();
  for (let index = 0; index < 25; index += 1) fire('error', { message: 'x'.repeat(1000), filename: EXTENSION_FILE, lineno: index, error: null });
  assert.equal(sent.length, 10);
  assert.equal(String(sent[0]?.message).length, 300);
});

test('a report is a folder name and a message, and nothing that names a path', () => {
  assert.deepEqual(parseErrorReport({ name: 'Quick-Notes', message: 'boom\nat line', file: '/scripts/x.js', line: 3, extra: 'ignored' }), { name: 'Quick-Notes', message: 'boom at line', file: '/scripts/x.js', line: 3 });
  for (const name of ['../etc', 'a/b', 'a\\b', '..', '.', '', 'x'.repeat(101)]) assert.equal(parseErrorReport({ name, message: 'm' }), null, name);
  assert.equal(parseErrorReport({ name: 'Notes', message: '' }), null);
  assert.equal(parseErrorReport({ name: 'Notes', message: 'm', line: -1 })?.line, null);
  assert.equal(parseErrorReport({ name: 'Notes', message: 'y'.repeat(5000) })?.message.length, 300);
  assert.equal(parseErrorReport('Notes'), null);
});

test('a server plugin that failed to load is read out of SillyTavern’s output', () => {
  assert.deepEqual(pluginFailure('[sillytavern] Failed to load plugin from /srv/st/plugins/my-plugin/index.js: Error: Cannot find module \'x\''), { name: 'my-plugin', message: 'Error: Cannot find module \'x\'', file: null, line: null });
  assert.equal(pluginFailure('[sillytavern] Failed to load plugin from C:\\ST\\plugins\\win-plugin\\package.json: SyntaxError: bad')?.name, 'win-plugin');
  assert.equal(pluginFailure('[sillytavern] 2 server plugin(s) are currently loaded.'), null);
});

function installation(id: string, ref: string, activatedAt: string | null): Installation {
  return { id, selector: 'latest', resolvedRef: ref, channel: 'release', runtimePath: '/runtime', markerPath: '/runtime/.stm-installation.json', status: 'ready', progress: 100, step: 'ready', error: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', activatedAt };
}

test('a version change is the active installation after another one, of another release', () => {
  const old = installation('a', '1.18.0', '2026-09-01T00:00:00Z');
  const current = installation('b', '1.19.0', '2026-10-01T00:00:00Z');
  assert.deepEqual(lastVersionChange([old, current], current), { version: '1.19.0', previous: '1.18.0', at: '2026-10-01T00:00:00Z' });
  assert.equal(lastVersionChange([current], current), null, 'a first install is not a change');
  assert.equal(lastVersionChange([installation('c', '1.19.0', '2026-09-01T00:00:00Z'), current], current), null, 'nor is the same release again');
  assert.equal(lastVersionChange([old, current], null), null);
});

test('an extension broke with a change only when its very first error came within a day after it', () => {
  const change = { version: '1.19.0', previous: '1.18.0', at: '2026-10-01T00:00:00.000Z' };
  assert.equal(brokeAfter('2026-10-01T03:00:00.000Z', change), '1.19.0');
  assert.equal(brokeAfter('2026-09-30T23:00:00.000Z', change), null, 'failing before is failing on its own');
  assert.equal(brokeAfter(new Date(Date.parse(change.at) + BROKE_WINDOW_MS + 1).toISOString(), change), null);
  assert.equal(brokeAfter('2026-10-01T03:00:00.000Z', null), null);
});

test('the store keeps twenty different errors, counts repeats, and remembers the first one', async () => {
  let now = new Date('2026-10-01T01:00:00.000Z');
  const stateDir = await mkdtemp(join(tmpdir(), 'stm-extension-errors-'));
  const store = new ExtensionErrorStore({ stateDir, now: () => now });
  for (let index = 0; index < 25; index += 1) {
    assert.equal(await store.record('extension', { name: 'Notes', message: `error ${index}`, file: null, line: null }, '1.19.0'), true);
    now = new Date(now.getTime() + 61_000);
  }
  await store.record('extension', { name: 'Notes', message: 'error 24', file: null, line: null }, '1.19.0');
  const errors = await store.errors('extension', 'Notes');
  assert.equal(errors.length, 20);
  assert.equal(errors[0]?.message, 'error 24');
  assert.equal(errors[0]?.count, 2);
  const change = { version: '1.19.0', previous: '1.18.0', at: '2026-10-01T00:00:00.000Z' };
  const summary = await store.summary('extension', 'Notes', change);
  assert.equal(summary?.count, 21);
  assert.equal(summary?.brokeAfter, '1.19.0', 'the first error is remembered though it left the list');
  assert.match(await readFile(join(stateDir, 'extension-errors.json'), 'utf8'), /error 24/u);

  const reopened = new ExtensionErrorStore({ stateDir, now: () => now });
  assert.equal((await reopened.errors('extension', 'Notes')).length, 20, 'kept across a restart');
  await reopened.clear('extension', 'Notes');
  assert.equal(await reopened.summary('extension', 'Notes', change), null);
  assert.deepEqual(await reopened.names('plugin'), []);
});

test('an extension that throws in a loop cannot fill the disk', async () => {
  const store = new ExtensionErrorStore({ stateDir: await mkdtemp(join(tmpdir(), 'stm-extension-errors-')), now: () => new Date('2026-10-01T00:00:00Z') });
  let kept = 0;
  for (let index = 0; index < 50; index += 1) if (await store.record('extension', { name: 'Loop', message: `e${index}`, file: null, line: null }, null)) kept += 1;
  assert.equal(kept, 30);
  assert.equal(await store.record('extension', { name: 'Other', message: 'e', file: null, line: null }, null), true, 'another extension is not held back by it');
});

test('extensions that broke with one change are named in one notification', async () => {
  const told: Array<[string, readonly string[]]> = [];
  const announcer = new BrokenAnnouncer((version, names) => told.push([version, names]), 20);
  announcer.add('1.19.0', 'Quick-Notes');
  announcer.add('1.19.0', 'Gallery');
  announcer.add('1.19.0', 'Quick-Notes');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
  assert.deepEqual(told, [['1.19.0', ['Gallery', 'Quick-Notes']]]);
});
