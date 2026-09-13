import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { ensurePanelBuilt, openInBrowser, panelStaticRoot } from '../src/bootstrap.js';
import { logLineText } from '../../../packages/contracts/src/index.js';

interface Launch { readonly file: string; readonly args: readonly string[] }

/** A spawn that records the call and reports whatever exit code the test wants. */
function recordingSpawn(launches: Launch[], code: number | null = 0): typeof spawn {
  return ((file: string, args: readonly string[]) => {
    launches.push({ file, args });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    if (code !== null) setImmediate(() => child.emit('close', code));
    return child;
  }) as unknown as typeof spawn;
}

test('a built panel is left alone and a missing one is built', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-bootstrap-'));
  const staticRoot = join(root, 'dist');
  const env = { STM_STATIC_ROOT: staticRoot };
  assert.equal(panelStaticRoot(env), staticRoot);

  // Nothing built yet: the build runs, and it is reported as having failed
  // because this spawn writes no output.
  const launches: Launch[] = [];
  const lines: string[] = [];
  assert.equal(await ensurePanelBuilt({ env, logger: (line) => lines.push(logLineText(line)), spawnImpl: recordingSpawn(launches) }), false);
  assert.deepEqual(launches.map((launch) => launch.args), [['run', 'panel:build']]);
  assert.ok(lines.some((line) => line.includes('npm run panel:build')));

  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html>', 'utf8');
  const afterBuild: Launch[] = [];
  assert.equal(await ensurePanelBuilt({ env, logger: () => undefined, spawnImpl: recordingSpawn(afterBuild) }), false);
  assert.deepEqual(afterBuild, []);
});

test('the console is opened for a person at the machine and not for a container', async () => {
  const launches: Launch[] = [];
  const opened = await openInBrowser('http://127.0.0.1:7860', { env: {}, logger: () => undefined, spawnImpl: recordingSpawn(launches, null) });
  assert.equal(opened, true);
  assert.deepEqual(launches[0]?.args, ['http://127.0.0.1:7860']);

  // Termux opens a URL through its own helper rather than xdg-open.
  const termux: Launch[] = [];
  await openInBrowser('http://127.0.0.1:7860', { env: { PREFIX: '/data/data/com.termux/files/usr' }, platform: 'linux', logger: () => undefined, spawnImpl: recordingSpawn(termux, null) });
  assert.equal(termux[0]?.file, 'termux-open-url');

  // A hosted studio and a container have no browser, and the operator can say no.
  for (const env of [{ STM_DATA_DIR: '/mnt/workspace/sillytavern-manager' }, { STM_DOCKER: '1' }, { STM_OPEN_BROWSER: '0' }]) {
    const skipped: Launch[] = [];
    assert.equal(await openInBrowser('http://127.0.0.1:7860', { env, platform: 'linux', logger: () => undefined, spawnImpl: recordingSpawn(skipped, null) }), false);
    assert.deepEqual(skipped, []);
  }
});
