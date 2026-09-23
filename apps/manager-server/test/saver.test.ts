import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';
import type { ProfileStore } from '../../../packages/profiles/src/index.js';
import type { R2Manager } from '../../../packages/r2/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { ProcessSupervisor } from '../src/supervisor.js';
import { BackupScheduler } from '../src/r2-scheduler.js';
import { SAVER_MEMORY_THRESHOLD_BYTES, SaverMode } from '../src/saver.js';
import { restoreWithProcess, RestoreRollbackError, startManagerServer } from '../src/server.js';
import type { Installation } from '../../../packages/contracts/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import { StateStore } from '../src/state.js';

const small = SAVER_MEMORY_THRESHOLD_BYTES - 1;
const large = SAVER_MEMORY_THRESHOLD_BYTES * 4;

test('a machine with little memory is in saver mode until somebody says otherwise', () => {
  const saver = new SaverMode({ env: {}, choice: null, memoryBytes: small });
  assert.equal(saver.enabled, true);
  assert.equal(saver.source, 'memory');
  assert.equal(new SaverMode({ env: {}, choice: null, memoryBytes: large }).enabled, false);
});

test('the panel’s switch overrides the memory, and STM_SAVER overrides both', () => {
  const chosen = new SaverMode({ env: {}, choice: false, memoryBytes: small });
  assert.equal(chosen.enabled, false);
  assert.equal(chosen.source, 'choice');
  chosen.choose(true);
  assert.equal(chosen.enabled, true);

  const forced = new SaverMode({ env: { STM_SAVER: '0' }, choice: true, memoryBytes: small });
  assert.equal(forced.enabled, false);
  assert.equal(forced.locked, true);
  assert.equal(forced.source, 'environment');
  assert.equal(new SaverMode({ env: { STM_SAVER: 'true' }, choice: false, memoryBytes: large }).enabled, true);
  // Anything else is not an answer, and leaves the decision where it was.
  assert.equal(new SaverMode({ env: { STM_SAVER: 'maybe' }, choice: null, memoryBytes: large }).locked, false);
});

test('the panel’s choice survives a restart, and a file without one has none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-saver-state-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths });
  assert.equal((await first.load()).saverMode, null);
  await first.setSaverMode(true);
  assert.equal((await new StateStore({ paths }).load()).saverMode, true);
});

test('saver mode writes no local archive, by hand or on the clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-saver-backup-'));
  const store = new BackupStore({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } }), logger: () => undefined });
  store.saving = true;
  await assert.rejects(() => store.create({ id: 'p1', name: 'Main' } as never), (error: unknown) => error instanceof BackupError && error.code === 'saver_mode');

  const created: string[] = [];
  const backups = {
    saving: true,
    isOperationRunning: () => false,
    pruneCreated: async () => 0,
    fingerprint: async () => 'changed',
    getSchedule: async () => ({ intervalMinutes: 60 }),
    list: async () => [],
    create: async (_profile: unknown, options: { kind: string }) => { created.push(options.kind); return { name: options.kind }; },
  } as unknown as BackupStore;
  const profiles = { getActive: async () => ({ id: 'p1', name: 'Main' }) } as unknown as ProfileStore;
  const r2 = { getConfig: async () => ({ enabled: false, configured: false }) } as unknown as R2Manager;
  await new BackupScheduler({ backups, profiles, r2, logger: () => undefined }).tick();
  assert.deepEqual(created, []);
});

function saverFakes() {
  const controller = new AbortController();
  const calls: string[] = [];
  const backups = {
    saving: true,
    reserve: () => () => undefined,
    reclassifyAsScheduled: async () => undefined,
    createSafetyCopy: async () => { calls.push('safety copy'); return { id: 'safety' }; },
    restore: async () => {
      calls.push('restore');
      controller.abort();
      throw new Error('The operation was stopped');
    },
  } as unknown as BackupStore;
  const supervisor = {
    stop: async () => ({ status: 'stopped' }),
    start: async () => { calls.push('start'); return { status: 'running' }; },
    getState: () => ({ status: 'stopped' }),
  } as unknown as ProcessSupervisor;
  return { controller, calls, backups, supervisor };
}

test('a saver mode restore keeps its copy in R2 rather than on the disk', async () => {
  const { controller, calls, backups, supervisor } = saverFakes();
  const safetyNet = async () => { calls.push('R2'); };
  // Stopped while writing, with no local copy to put back: said as such, not
  // reported as a clean stop.
  await assert.rejects(
    () => restoreWithProcess({ profile: { id: 'p1', name: 'Main' } as never, backups, supervisor, archivePath: '/archives/chosen.zip', mode: 'replace', signal: controller.signal, safetyNet }),
    RestoreRollbackError,
  );
  assert.deepEqual(calls, ['R2', 'restore', 'start']);
});

test('a saver mode restore whose R2 copy fails writes nothing', async () => {
  const { calls, backups, supervisor } = saverFakes();
  const safetyNet = async () => { throw new Error('R2 is unreachable'); };
  await assert.rejects(
    () => restoreWithProcess({ profile: { id: 'p1', name: 'Main' } as never, backups, supervisor, archivePath: '/archives/chosen.zip', mode: 'replace', safetyNet }),
    /unreachable/u,
  );
  assert.deepEqual(calls, ['start']);
});

test('a restore with no archive writes through what it is handed, after the R2 copy', async () => {
  const calls: string[] = [];
  const backups = { saving: true, reserve: () => () => undefined, reclassifyAsScheduled: async () => undefined } as unknown as BackupStore;
  const supervisor = {
    stop: async () => { calls.push('stop'); return { status: 'stopped' }; },
    start: async () => { calls.push('start'); return { status: 'running' }; },
    getState: () => ({ status: 'stopped' }),
  } as unknown as ProcessSupervisor;
  const result = await restoreWithProcess({
    profile: { id: 'p1', name: 'Main' } as never, backups, supervisor, mode: 'replace',
    safetyNet: async () => { calls.push('R2'); },
    write: async (options) => { calls.push(`write ${options.mode}`); return { fileCount: 3 } as never; },
  });
  // SillyTavern is stopped before anything is fetched and started once it is all written.
  assert.deepEqual(calls, ['stop', 'R2', 'write replace', 'start']);
  assert.equal(result.safetySnapshot, null);
});

test('in saver mode an uploaded zip goes straight into the profile and is never kept', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-saver-stream-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, saver: new SaverMode({ env: { STM_SAVER: '1' }, choice: null }), logger: () => undefined });
  t.after(() => manager.close());
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = /stm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')?.[0] ?? '';
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profile = (await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ dataPath: string }> }).profiles[0];
  assert.ok(profile);
  const userRoot = join(profile.dataPath, 'default-user');
  await mkdir(join(userRoot, 'chats'), { recursive: true });
  await writeFile(join(userRoot, 'settings.json'), '{"from":"before"}', 'utf8');
  await writeFile(join(userRoot, 'chats', 'stale.jsonl'), 'not in the upload', 'utf8');

  // The archive, written somewhere else the way somebody's own backup would be.
  const elsewhere = await mkdtemp(join(tmpdir(), 'stm-saver-stream-source-'));
  const sourceRoot = join(elsewhere, 'runtime', 'data', 'default-user');
  await mkdir(join(sourceRoot, 'chats'), { recursive: true });
  const chat = randomBytes(300_000).toString('base64');
  await writeFile(join(sourceRoot, 'settings.json'), '{"from":"upload"}', 'utf8');
  await writeFile(join(sourceRoot, 'chats', 'kept.jsonl'), chat, 'utf8');
  const sourceStore = new BackupStore({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: elsewhere } }), logger: () => undefined });
  const sourceProfile = { id: 'source', name: 'Source', installationId: 'x', runtimePath: join(elsewhere, 'runtime'), configPath: join(elsewhere, 'runtime', 'config.yaml'), dataPath: join(elsewhere, 'runtime', 'data'), layout: 'data', active: true, createdAt: now, updatedAt: now, activatedAt: now } as const;
  const archive = await readFile((await sourceStore.getArchivePath((await sourceStore.create(sourceProfile)).id))!);
  const tail = archive.subarray(archive.readUInt32LE(archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16));

  const headers = { cookie, 'x-csrf-token': csrf };
  const opened = await fetch(`${base}/api/v1/backups/stream`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-archive-size': String(archive.length) }, body: tail });
  assert.equal(opened.status, 200);
  const preview = await opened.json() as { uploadId: string; fileCount: number; recognized: boolean };
  assert.equal(preview.fileCount, 2);
  assert.equal(preview.recognized, true);
  const started = await fetch(`${base}/api/v1/backups/stream/restore`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: preview.uploadId, mode: 'replace' }) });
  assert.equal(started.status, 202);
  const { jobId } = await started.json() as { jobId: string };

  const size = 64 * 1024;
  for (let index = 0; index * size < archive.length;) {
    const sent = await fetch(`${base}/api/v1/backups/stream/chunk?uploadId=${preview.uploadId}&index=${index}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: archive.subarray(index * size, (index + 1) * size) });
    assert.ok(sent.ok, `chunk ${index} answered ${sent.status}`);
    const answer = await sent.json() as { ready: boolean; done?: boolean };
    if (!answer.ready) continue;
    index += 1;
    if (answer.done) break;
  }
  for (let attempt = 0; ; attempt += 1) {
    const job = await (await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } })).json() as { state: string; error?: string };
    if (job.state === 'succeeded') break;
    if (job.state === 'failed' || attempt > 200) throw new Error(job.error ?? 'the restore did not finish');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(await readFile(join(userRoot, 'settings.json'), 'utf8'), '{"from":"upload"}');
  assert.equal(await readFile(join(userRoot, 'chats', 'kept.jsonl'), 'utf8'), chat);
  await assert.rejects(() => readFile(join(userRoot, 'chats', 'stale.jsonl')), { code: 'ENOENT' });
  // Neither the library nor the scratch directory kept any of it.
  assert.deepEqual((await (await fetch(`${base}/api/v1/backups`, { headers: { cookie } })).json() as { backups: unknown[] }).backups, []);
  assert.deepEqual(await readdir(paths.archives).catch(() => []), []);
  assert.deepEqual((await readdir(paths.tmp).catch(() => [] as string[])).filter((name) => name.endsWith('.zip') || name.endsWith('.part')), []);
});
