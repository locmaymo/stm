import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { isLogEvent, logLineText, type Installation, type LogLine, type Profile } from '../../../packages/contracts/src/index.js';
import { ProcessSupervisor } from '../src/supervisor.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';

test('process supervisor starts the marker-verified active runtime and captures output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-supervisor-'));
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, JSON.stringify({ installationId: 'install-1', resolvedRef: '1.0.0' }), 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log('ready'); setInterval(() => {}, 1000);", 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const lines: string[] = [];
  const supervisor = new ProcessSupervisor({ runtime: { getActiveInstallation: async () => installation } as never, readinessCheck: async () => undefined, logger: (line) => lines.push(logLineText(line)) });
  const started = await supervisor.start();
  assert.equal(started.status, 'running');
  assert.equal(started.installationId, installation.id);
  const deadline = Date.now() + 2_000;
  while (!lines.some((line) => line.includes('ready')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await supervisor.stop();
  assert.equal(supervisor.getState().status, 'stopped');
  assert.ok(lines.some((line) => line.includes('ready')));
});

test('a tunnel that cannot get cloudflared says so instead of starting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  // cloudflared is downloaded when it is missing, so the only way left to be
  // without it is for that download to fail. The fetch is injected because a
  // test must never reach the network.
  const fetchImpl = (async () => { throw new Error('the host is offline'); }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, binaryPath: join(root, 'missing-cloudflared'), env: { PATH: root }, fetchImpl });
  const state = await tunnel.start('quick');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /the host is offline/u);
});

test('data-layout profiles are passed to SillyTavern without changing the runtime path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-supervisor-profile-'));
  const runtimePath = join(root, 'runtime');
  const dataPath = join(root, 'profile-data');
  const configPath = join(root, 'profile-config.yaml');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, JSON.stringify({ installationId: 'install-1', resolvedRef: '1.0.0' }), 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log(process.argv.slice(2).join('|')); setInterval(() => {}, 1000);", 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const profile: Profile = { id: 'profile-1', name: 'Data', installationId: installation.id, runtimePath, configPath, dataPath, layout: 'data', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const lines: string[] = [];
  const supervisor = new ProcessSupervisor({ runtime: { getActiveInstallation: async () => installation } as never, profileResolver: async () => profile, readinessCheck: async () => undefined, logger: (line) => lines.push(logLineText(line)) });
  const started = await supervisor.start();
  assert.equal(started.profileId, profile.id);
  const deadline = Date.now() + 2_000;
  while (!lines.some((line) => line.includes('--dataRoot')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await supervisor.stop();
  assert.ok(lines.some((line) => line.includes(`--dataRoot|${dataPath}|--configPath|${configPath}`)));
  assert.equal(supervisor.getState().profileId, profile.id);
});

test('large legacy profiles receive an expanded Node heap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-supervisor-legacy-heap-'));
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, JSON.stringify({ installationId: 'install-1', resolvedRef: '1.0.0' }), 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log(process.argv.slice(2).join('|')); setInterval(() => {}, 1000);", 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const profile: Profile = { id: 'profile-1', name: 'Legacy data', installationId: installation.id, runtimePath, configPath: join(root, 'profile-config.yaml'), dataPath: join(root, 'profile-data'), layout: 'data', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const lines: string[] = [];
  const supervisor = new ProcessSupervisor({
    runtime: { getActiveInstallation: async () => installation } as never,
    profileResolver: async () => profile,
    profileLifecycle: { prepare: async () => 'public', persist: async () => undefined, legacyHeapMb: async () => 8192 },
    readinessCheck: async () => undefined,
    logger: (line) => lines.push(logLineText(line)),
  });
  await supervisor.start();
  const deadline = Date.now() + 2_000;
  while (!lines.some((line) => line.includes('using 8192 MiB heap')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await supervisor.stop();
  assert.ok(lines.some((line) => line.includes('using 8192 MiB heap')));
});

test('a stop the manager asked for says what asked for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-stop-reason-'));
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, JSON.stringify({ installationId: 'install-1', resolvedRef: '1.0.0' }), 'utf8');
  await writeFile(join(runtimePath, 'server.js'), 'setInterval(() => {}, 1000);', 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const events: LogLine[] = [];
  const supervisor = new ProcessSupervisor({ runtime: { getActiveInstallation: async () => installation } as never, readinessCheck: async () => undefined, logger: (line) => events.push(line) });
  await supervisor.start();
  await supervisor.stop('restore');
  const stopped = events.filter(isLogEvent).find((event) => event.code.startsWith('sillytavern.stopped'));
  assert.equal(stopped?.code, 'sillytavern.stoppedRestore');
  assert.equal(supervisor.getState().error, null);
});

test('a process nobody asked to stop reports that it exited on its own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-crash-'));
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, JSON.stringify({ installationId: 'install-1', resolvedRef: '1.0.0' }), 'utf8');
  await writeFile(join(runtimePath, 'server.js'), 'process.exit(3);', 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const events: LogLine[] = [];
  const supervisor = new ProcessSupervisor({ runtime: { getActiveInstallation: async () => installation } as never, readinessCheck: async () => undefined, logger: (line) => events.push(line) });
  await supervisor.start();
  const deadline = Date.now() + 5_000;
  while (!events.filter(isLogEvent).some((event) => event.code === 'sillytavern.exited') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const exited = events.filter(isLogEvent).find((event) => event.code === 'sillytavern.exited');
  assert.equal(exited?.params?.detail, 'exit code 3');
  assert.match(supervisor.getState().error ?? '', /exited on its own/u);
  await supervisor.close();
});
