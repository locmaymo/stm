import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
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

test('a panel older than its sources is built again rather than served as it is', async () => {
  // Serving whatever was built first is how a console ends up calling an API
  // that has moved on: every field comes back undefined, every control it
  // cannot account for is disabled, and nothing anywhere says why.
  const root = await mkdtemp(join(tmpdir(), 'stm-bootstrap-stale-'));
  const staticRoot = join(root, 'dist');
  const source = join(root, 'src');
  const env = { STM_STATIC_ROOT: staticRoot };
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'nested', 'App.tsx'), 'export const panel = 1;\n', 'utf8');
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html>', 'utf8');

  // Built after the sources: nothing to do.
  const fresh: Launch[] = [];
  assert.equal(await ensurePanelBuilt({ env, sourceRoots: [source], logger: () => undefined, spawnImpl: recordingSpawn(fresh) }), false);
  assert.deepEqual(fresh, []);

  /*
   * A source written afterwards is what makes the build out of date - but on a
   * fast filesystem "afterwards" and "at the same moment" are the same
   * millisecond, and the comparison is `<=`, so the two writes above could tie
   * and the rebuild be skipped. About one run in three did exactly that. The
   * source is given a timestamp a second past the build rather than a race
   * against the clock: it is the same condition, stated rather than hoped for.
   */
  const builtAt = (await stat(join(staticRoot, 'index.html'))).mtime;
  await writeFile(join(source, 'nested', 'App.tsx'), 'export const panel = 2;\n', 'utf8');
  const afterTheBuild = new Date(builtAt.getTime() + 1_000);
  await utimes(join(source, 'nested', 'App.tsx'), afterTheBuild, afterTheBuild);
  const stale: Launch[] = [];
  const lines: string[] = [];
  await ensurePanelBuilt({ env, sourceRoots: [source], logger: (line) => lines.push(logLineText(line)), spawnImpl: recordingSpawn(stale) });
  assert.deepEqual(stale.map((launch) => launch.args), [['run', 'panel:build']]);
  assert.ok(lines.some((line) => line.includes('older than the sources')));

  // A spawn that throws rather than reporting - which is what Node does for a
  // .cmd on Windows - must not end the manager before it listens.
  const throwing = ((): never => { throw new Error('spawn EINVAL'); }) as unknown as typeof spawn;
  assert.equal(await ensurePanelBuilt({ env, sourceRoots: [source], logger: () => undefined, spawnImpl: throwing }), false);

  // An installed release ships no sources, so it never rebuilds.
  const released: Launch[] = [];
  assert.equal(await ensurePanelBuilt({ env, sourceRoots: [join(root, 'not-here')], logger: () => undefined, spawnImpl: recordingSpawn(released) }), false);
  assert.deepEqual(released, []);
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
