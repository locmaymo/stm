import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { Installation } from '../../../packages/contracts/src/index.js';
import { BackupStore } from '../../../packages/backup/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import type { TunnelManager } from '../../../packages/tunnel/src/index.js';
import type { AccessGateway } from '../src/gateway.js';
import type { TunnelState } from '../../../packages/contracts/src/index.js';
import { StateStore } from '../src/state.js';
import { applyManagerSettings, currentManagerSettings, foreignManagerSettings, managerSettingsOffer, saveManagerSettings, type ManagerSettingsDeps } from '../src/manager-settings.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import { releaseToInstall } from '../src/server.js';

const CREDENTIALS = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'stm-test-bucket',
  accessKeyId: 'access-key-1234',
  secretAccessKey: 'secret-key-5678',
  enabled: true,
} as const;

/** One bucket, shared by every manager a test makes. */
function sharedBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
    }
    if (method === 'PUT') {
      objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer()));
      return new Response('', { status: 200 });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      if (!body) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    }
    // Honoured rather than merely acknowledged: the copy of a record kept
    // across a handover is thrown away by deleting it, and a fake that keeps
    // it would let this pass over a console that goes on offering settings it
    // has already restored.
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response('', { status: 204 });
    }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects };
}

const INSTALLATION = { id: 'install-1', selector: 'latest', resolvedRef: '1.13.2', status: 'ready' } as unknown as Installation;

/**
 * A tunnel that only remembers whether it was asked to be on.
 *
 * Enough for these: what the record carries is the mode, and what a restore
 * does with it is start or stop the quick kind. Starting a real one would
 * download cloudflared and open a link to the internet from a test run.
 */
/**
 * The door in front of SillyTavern, as much of it as a restore touches.
 *
 * It has to be told the credential before a tunnel is started, because a
 * tunnel refuses to open in front of a door with no password on it.
 */
function fakeGateway(): AccessGateway {
  let passwordConfigured = false;
  let lan = false;
  return {
    setPassword: (hash: string | null) => { passwordConfigured = hash !== null; },
    setLan: async (next: boolean) => { lan = next; return { passwordConfigured, lan }; },
    getState: () => ({ passwordConfigured, lan }),
  } as unknown as AccessGateway;
}

function fakeTunnel(mode: TunnelState['mode'] = 'off'): TunnelManager {
  let state = { mode, status: 'stopped', url: null, startedAt: null, error: null } as TunnelState;
  return {
    getState: () => state,
    start: async () => { state = { ...state, mode: 'quick', status: 'running' }; return state; },
    disable: async () => { state = { ...state, mode: 'off', status: 'stopped' }; return state; },
  } as unknown as TunnelManager;
}

async function machine(fetchImpl: typeof fetch, label: string, tunnels: { tunnel?: TunnelManager; managerTunnel?: TunnelManager } = {}): Promise<ManagerSettingsDeps> {
  const root = await mkdtemp(join(tmpdir(), `stm-mgr-${label}-`));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new StateStore({ paths });
  await store.load();
  const backups = new BackupStore({ paths, logger: () => undefined });
  const r2 = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, fetchImpl, installationLabel: label });
  await r2.update({ ...CREDENTIALS });
  const runtime = { getActiveInstallation: async () => INSTALLATION } as unknown as RuntimeManager;
  return {
    store, backups, r2, runtime,
    tunnel: tunnels.tunnel ?? fakeTunnel(),
    managerTunnel: tunnels.managerTunnel ?? fakeTunnel(),
    gateway: fakeGateway(),
    logger: () => undefined,
  };
}

test('a machine that is gone leaves behind enough to be a machine again', async () => {
  const bucket = sharedBucket();
  // The laptop was reached from a phone, which means a Quick Tunnel was open.
  const laptop = await machine(bucket.fetchImpl, 'laptop', { tunnel: fakeTunnel('quick') });

  // The laptop as somebody actually set it up: a console password, a passcode
  // on the door in front of SillyTavern, reachable over the house Wi-Fi, a
  // slower backup schedule than the default.
  await laptop.store.saveAdminPassword(hashPassword('console password'));
  await laptop.store.setAccessPassword(hashPassword('123456'), true);
  await laptop.store.setAccessLan(true);
  await laptop.store.setAutoStartSillyTavern(false);
  await laptop.backups.setSchedule({ intervalMinutes: 180 });
  await laptop.r2.update({ hotIntervalMinutes: 15, keepDaily: 7 });
  assert.equal(await saveManagerSettings(laptop), true);

  // A different computer, set up from nothing an hour later. It has its own
  // console password and knows nothing about the laptop.
  const desktop = await machine(bucket.fetchImpl, 'desktop');
  await desktop.store.saveAdminPassword(hashPassword('a different password'));

  const offer = await managerSettingsOffer(desktop);
  assert.equal(offer.available, true);
  assert.equal(offer.label, 'laptop');
  assert.equal(offer.mine, false, 'these are somebody else’s settings, and saying so is the point');
  assert.equal(offer.hasAdminPassword, true);

  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  const result = await applyManagerSettings(desktop, record, { passwords: true, schedules: true, ports: { manager: 7860, access: 8001 } });
  assert.ok(result.applied.includes('managerPassword'));

  const state = await desktop.store.getPersisted();
  assert.ok(state.adminPasswordHash && verifyPassword('console password', state.adminPasswordHash), 'the password from the laptop opens this console');
  assert.ok(state.accessPasswordHash && verifyPassword('123456', state.accessPasswordHash));
  assert.equal(state.accessPasscode, true);
  assert.equal(state.accessLanEnabled, true);
  // The passcode without the door it opens is half a restore. This is the part
  // that is visible from the phone somebody was using, and the part whose
  // absence read as nothing having been restored at all.
  assert.ok(result.applied.includes('accessTunnel'));
  assert.equal(desktop.tunnel.getState().mode, 'quick');
  // The door has the credential before the tunnel is put in front of it: a
  // tunnel refuses to open onto a door with no password on it, so restoring
  // them the other way round left the tunnel refused on the one machine whose
  // passcode had just come back.
  assert.equal(desktop.gateway.getState().passwordConfigured, true);
  assert.equal(state.autoStartSillyTavern, false);
  assert.equal((await desktop.backups.getSchedule()).intervalMinutes, 180);
  assert.equal((await desktop.r2.getConfig()).schedule.hotIntervalMinutes, 15);
  assert.equal((await desktop.r2.getConfig()).retention.keepDaily, 7);

  // And now it is this machine's record, so there is nothing left to offer -
  // including the copy kept aside while the handover was still unanswered.
  assert.equal((await managerSettingsOffer(desktop)).available, false);
});

test('only the parts that were asked for are put back', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  await laptop.store.saveAdminPassword(hashPassword('console password'));
  await laptop.backups.setSchedule({ intervalMinutes: 180 });
  await saveManagerSettings(laptop);

  // Somebody who has already set this machine up and only wants the schedules
  // back does not want to be signed out of the console they are looking at.
  const desktop = await machine(bucket.fetchImpl, 'desktop');
  await desktop.store.saveAdminPassword(hashPassword('mine, and staying'));
  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  await applyManagerSettings(desktop, record, { passwords: false, schedules: true, ports: { manager: 7860, access: 8001 } });

  const state = await desktop.store.getPersisted();
  assert.ok(state.adminPasswordHash && verifyPassword('mine, and staying', state.adminPasswordHash));
  assert.equal((await desktop.backups.getSchedule()).intervalMinutes, 180);
});

test('a port this machine cannot have is reported rather than taken', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  // The laptop ran SillyTavern on the port that is this machine's console.
  await laptop.store.setSillyTavernPort(7860);
  await saveManagerSettings(laptop);

  const desktop = await machine(bucket.fetchImpl, 'desktop');
  const before = (await desktop.store.getPersisted()).sillyTavernPort;
  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  const result = await applyManagerSettings(desktop, record, { passwords: false, schedules: false, ports: { manager: 7860, access: 8001 } });

  assert.ok(result.skipped.includes('sillyTavernPort'));
  assert.equal((await desktop.store.getPersisted()).sillyTavernPort, before, 'the port that works here is kept');
});

/*
 * The state file was never the whole of it. A running manager holds the port
 * in the gateway it forwards through, in the health check that waits for
 * SillyTavern to answer and in the writer of config.yaml - all taken at
 * startup. A restore that wrote only the file left every one of them on the
 * default, so a machine put back together said 8006 and ran SillyTavern on
 * 8002, with every other restored setting right.
 */
test('the port that comes back reaches the running manager, not only the file', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  await laptop.store.setSillyTavernPort(8006);
  await saveManagerSettings(laptop);

  const adopted: number[] = [];
  const desktop = await machine(bucket.fetchImpl, 'desktop');
  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  const result = await applyManagerSettings(
    { ...desktop, adoptSillyTavernPort: async (port) => { adopted.push(port); } },
    record,
    { passwords: false, schedules: false, ports: { manager: 7860, access: 8001 } },
  );

  assert.ok(result.applied.includes('sillyTavernPort'));
  assert.equal((await desktop.store.getPersisted()).sillyTavernPort, 8006);
  assert.deepEqual(adopted, [8006], 'the manager is told, not only the state file');
});

/** A port this machine cannot have never reaches the running manager either. */
test('a refused port is not handed to the running manager', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  await laptop.store.setSillyTavernPort(7860);
  await saveManagerSettings(laptop);

  const adopted: number[] = [];
  const desktop = await machine(bucket.fetchImpl, 'desktop');
  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  const result = await applyManagerSettings(
    { ...desktop, adoptSillyTavernPort: async (port) => { adopted.push(port); } },
    record,
    { passwords: false, schedules: false, ports: { manager: 7860, access: 8001 } },
  );

  assert.ok(result.skipped.includes('sillyTavernPort'));
  assert.deepEqual(adopted, []);
});

test('what is sent is what the manager is actually set to', async () => {
  const bucket = sharedBucket();
  const only = await machine(bucket.fetchImpl, 'laptop');
  await only.store.setSillyTavernPort(8123);
  const record = await currentManagerSettings(only);
  assert.equal(record.sillyTavernPort, 8123);
  assert.equal(record.versionSelector, 'latest');
  // Resolved, so a machine put back together gets the release it was running
  // rather than whatever is newest on the day it comes back.
  assert.equal(record.versionRef, '1.13.2');
  // Nothing is invented: a manager with no password set says so rather than
  // sending an empty string that would restore as a password of nothing.
  assert.equal(record.adminPasswordHash, null);
});

test('a machine put back together installs the release it was running', async () => {
  /*
   * The record carries both: what the reader picked and what that resolved to
   * on the day. Only the second is a version. Installing "latest" onto a
   * machine being rebuilt a month later and then restoring a profile written
   * by the SillyTavern before it is an upgrade nobody asked for, performed on
   * the reader's only copy of their data.
   */
  assert.equal(releaseToInstall('1.13.2'), '1.13.2');
  // A branch resolves to itself, and following it is what was chosen.
  assert.equal(releaseToInstall('staging'), 'staging');
  // A record from before this was written down, or one holding something the
  // runtime would refuse. Latest is a worse answer than the right version and
  // an enormously better one than nothing installed at all.
  assert.equal(releaseToInstall(null), 'latest');
  assert.equal(releaseToInstall(''), 'latest');
  assert.equal(releaseToInstall('../../etc/passwd'), 'latest');
});

test('the machine being offered survives this one writing its own settings', async () => {
  /*
   * One bucket describes one machine, so a machine that takes the bucket
   * writes its own settings over whatever was there. That is right - it is the
   * machine now - and it was quietly destroying the thing the console was in
   * the middle of offering.
   *
   * The window was one scheduler tick. Sign in on a machine that is already
   * set up, wait about a minute, and the card still said "this account holds
   * the setup of <the old machine>" while the record behind it had become this
   * machine's own - so pressing Restore everything restored this machine onto
   * itself, and the log named the wrong machine while doing it. Seen against a
   * live account before it was written down here.
   */
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  await laptop.store.saveAdminPassword(hashPassword('console password'));
  await laptop.backups.setSchedule({ intervalMinutes: 180 });
  assert.equal(await saveManagerSettings(laptop), true);

  const desktop = await machine(bucket.fetchImpl, 'desktop');
  await desktop.store.saveAdminPassword(hashPassword('a different password'));
  await desktop.backups.setSchedule({ intervalMinutes: 15 });
  assert.equal((await managerSettingsOffer(desktop)).label, 'laptop');

  // The scheduler, a minute after signing in.
  assert.equal(await saveManagerSettings(desktop), true);

  // The current record is this machine's now, and the laptop is still the
  // machine the console is offering to bring back.
  assert.equal((await desktop.r2.loadManagerSettings())?.label, 'desktop');
  const offer = await managerSettingsOffer(desktop);
  assert.equal(offer.available, true);
  assert.equal(offer.label, 'laptop');
  assert.equal(offer.mine, false);

  // And restoring it restores the laptop, not this machine onto itself.
  const record = await foreignManagerSettings(desktop);
  assert.equal(record?.label, 'laptop');
  await applyManagerSettings(desktop, record!, { passwords: true, schedules: true, ports: { manager: 7860, access: 8001 } });
  const state = await desktop.store.getPersisted();
  assert.ok(state.adminPasswordHash && verifyPassword('console password', state.adminPasswordHash));
  assert.equal((await desktop.backups.getSchedule()).intervalMinutes, 180);

  // Answered, so it stops being offered.
  assert.equal((await managerSettingsOffer(desktop)).available, false);
});
