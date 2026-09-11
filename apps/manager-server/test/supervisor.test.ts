import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { Installation, Profile } from '../../../packages/contracts/src/index.js';
import { ProcessSupervisor } from '../src/supervisor.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';

test('process supervisor starts the marker-verified active runtime and captures output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-supervisor-'));
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, '{}', 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log('ready'); setInterval(() => {}, 1000);", 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const lines: string[] = [];
  const supervisor = new ProcessSupervisor({ runtime: { getActiveInstallation: async () => installation } as never, logger: (line) => lines.push(line) });
  const started = await supervisor.start();
  assert.equal(started.status, 'running');
  assert.equal(started.installationId, installation.id);
  const deadline = Date.now() + 2_000;
  while (!lines.some((line) => line.includes('ready')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await supervisor.stop();
  assert.equal(supervisor.getState().status, 'stopped');
  assert.ok(lines.some((line) => line.includes('ready')));
});

test('tunnel manager reports a clear missing-cloudflared capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const tunnel = new TunnelManager({ paths, binaryPath: join(root, 'missing-cloudflared'), env: { PATH: root } });
  const state = await tunnel.start('quick');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /cloudflared was not found/u);
});

test('data-layout profiles are passed to SillyTavern without changing the runtime path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-supervisor-profile-'));
  const runtimePath = join(root, 'runtime');
  const dataPath = join(root, 'profile-data');
  const configPath = join(root, 'profile-config.yaml');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  const markerPath = join(runtimePath, '.stm-installation.json');
  await writeFile(markerPath, '{}', 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log(process.argv.slice(2).join('|')); setInterval(() => {}, 1000);", 'utf8');
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath, status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const profile: Profile = { id: 'profile-1', name: 'Data', installationId: installation.id, runtimePath, configPath, dataPath, layout: 'data', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
  const lines: string[] = [];
  const supervisor = new ProcessSupervisor({ runtime: { getActiveInstallation: async () => installation } as never, profileResolver: async () => profile, logger: (line) => lines.push(line) });
  const started = await supervisor.start();
  assert.equal(started.profileId, profile.id);
  const deadline = Date.now() + 2_000;
  while (!lines.some((line) => line.includes('--dataRoot')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await supervisor.stop();
  assert.ok(lines.some((line) => line.includes(`--dataRoot|${dataPath}|--configPath|${configPath}`)));
  assert.equal(supervisor.getState().profileId, profile.id);
});
