import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn as spawnType } from 'node:child_process';
import { getPlatformPaths } from '../../platform/src/index.js';
import { parseTunnelUrl, TunnelManager } from '../src/index.js';

const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

async function createPaths(): Promise<ReturnType<typeof getPlatformPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-'));
  return getPlatformPaths({ env: { STM_DATA_DIR: root } });
}

/** A cloudflared that never runs, so the manager's own behaviour is what is under test. */
interface FakeCloudflared extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

function fakeCloudflared(): FakeCloudflared {
  const child = new EventEmitter() as FakeCloudflared;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    // A real process does not exit inside the call that signals it, and a fake
    // that does would let a missing `close` listener pass unnoticed.
    kill(): boolean { setImmediate(() => { child.exitCode = 0; child.emit('close', null, 'SIGTERM'); }); return true; },
  });
  return child;
}

/** A binary that is already present, so nothing is downloaded during a test. */
async function installFakeBinary(paths: ReturnType<typeof getPlatformPaths>): Promise<void> {
  await mkdir(paths.bin, { recursive: true });
  await writeFile(join(paths.bin, binaryName), 'fake cloudflared', { mode: 0o755 });
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = (): void => {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${label}`)); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

test('cloudflared is downloaded on first use and reused afterwards', async () => {
  const paths = await createPaths();
  let requests = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    requests += 1;
    assert.match(String(url), /cloudflare\/cloudflared\/releases\/latest\/download\//u);
    return new Response('#!/bin/true\n', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });

  const first = await tunnel.ensureBinary();
  assert.equal(first, join(paths.bin, binaryName));
  assert.equal(await readFile(first, 'utf8'), '#!/bin/true\n');
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o111, 0o111);

  // A second start must not fetch it again, and must not leave a part file.
  assert.equal(await tunnel.ensureBinary(), first);
  assert.equal(requests, 1);
  assert.deepEqual((await readdir(paths.bin)).sort(), [binaryName]);
});

test('a binary already on disk is used without a download', async () => {
  const paths = await createPaths();
  await mkdir(paths.bin, { recursive: true });
  await writeFile(join(paths.bin, binaryName), 'already here', { mode: 0o755 });
  const fetchImpl = (async () => { throw new Error('the network must not be reached'); }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });
  assert.equal(await tunnel.ensureBinary(), join(paths.bin, binaryName));
});

/**
 * A Linux binary with the load address Cloudflare's own builds use (2, fixed)
 * or the one Android insists on (3, position-independent).
 */
function elfBinary(type: 2 | 3): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  header.writeUInt16LE(type, 16);
  header.writeUInt16LE(183, 18);
  return header;
}

test('on Termux a build Android will not start is run through proot instead', async () => {
  // A Termux prefix, which is how the manager knows it is on Android at all.
  const prefix = await mkdtemp(join(tmpdir(), 'com.termux-'));
  const root = join(prefix, 'var', 'sillytavern-manager');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root, PREFIX: prefix } });
  // Cloudflare's own build: the one the manager downloads, and the one Android
  // refuses to start on its own.
  const cloudflared = join(prefix, binaryName);
  await writeFile(cloudflared, elfBinary(2), { mode: 0o755 });
  await mkdir(join(prefix, 'bin'), { recursive: true });
  const chroot = join(prefix, 'bin', 'termux-chroot');
  await writeFile(chroot, 'proot stub', { mode: 0o755 });
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]): ChildProcess => {
    spawns.push({ command, args });
    return fakeCloudflared() as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({ paths, binaryPath: cloudflared, spawnImpl, env: { PATH: '', PREFIX: prefix }, logger: () => undefined });

  const state = await tunnel.start('quick');
  assert.equal(state.status, 'starting');
  assert.equal(spawns[0]?.command, chroot);
  assert.deepEqual(spawns[0]?.args.slice(0, 2), [cloudflared, 'tunnel']);
  // A phone is where QUIC is blocked and IPv6 is half-configured.
  assert.deepEqual(spawns[0]?.args.slice(2), ['--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--url', 'http://127.0.0.1:8001']);
  await tunnel.close();
});

test('on Termux a build Android starts by itself needs no proot in front of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-termux-native-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root, PREFIX: '/data/data/com.termux/files/usr' } });
  // What `pkg install cloudflared` leaves behind: a position-independent build.
  const packaged = join(root, binaryName);
  await writeFile(packaged, elfBinary(3), { mode: 0o755 });
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]): ChildProcess => {
    spawns.push({ command, args });
    return fakeCloudflared() as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({ paths, binaryPath: packaged, spawnImpl, env: { PATH: '' }, logger: () => undefined });

  await tunnel.start('quick');
  assert.equal(spawns[0]?.command, packaged);
  assert.equal(spawns[0]?.args[0], 'tunnel');
  await tunnel.close();
});

test('a fixed-address binary is left alone off Android, where the loader runs it', async () => {
  const paths = await createPaths();
  await mkdir(paths.bin, { recursive: true });
  await writeFile(join(paths.bin, binaryName), elfBinary(2), { mode: 0o755 });
  const fetchImpl = (async () => { throw new Error('the network must not be reached'); }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });
  assert.equal(await tunnel.ensureBinary(), join(paths.bin, binaryName));
});

test('a failed download reports the status and leaves nothing behind', async () => {
  const paths = await createPaths();
  const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });
  await assert.rejects(() => tunnel.ensureBinary(), /HTTP 503/u);

  const state = await tunnel.start('quick');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /HTTP 503/u);
});

test('the public address is the address, not whatever someone just opened', () => {
  // cloudflared names the address once in a banner and then again in every
  // request it logs. Allowing a path after the hostname meant the link shown
  // in the console became whichever file was fetched last, and changed again
  // on the next line - which is what made it look like it would not sit still.
  const banner = '2026-09-14T03:17:39Z INF |  https://cedar-married-designer-ticket.trycloudflare.com                    |';
  assert.equal(parseTunnelUrl(banner), 'https://cedar-married-designer-ticket.trycloudflare.com');

  const request = '2026-09-14T03:47:36Z ERR Request failed error="Incoming request ended abruptly" connIndex=0 dest=https://surgical-similarly-meters-astronomy.trycloudflare.com/user/images/Assistant/1786509894388_5328437723185702.mp4 event=0';
  assert.equal(parseTunnelUrl(request), 'https://surgical-similarly-meters-astronomy.trycloudflare.com');

  const root = 'ERR dest=https://spectrum-volleyball-melissa-cottage.trycloudflare.com/ event=0';
  assert.equal(parseTunnelUrl(root), 'https://spectrum-volleyball-melissa-cottage.trycloudflare.com');

  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), undefined);
});

test('an exit nobody asked for is reconnected, and a requested stop is not', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const lines: string[] = [];
  const spawnImpl = ((): ChildProcess => {
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({
    paths,
    spawnImpl,
    env: { PATH: '' },
    reconnectDelaysMs: [5],
    logger: (line) => { lines.push(typeof line === 'string' ? line : line.message); },
  });

  await tunnel.start('quick');
  assert.equal(children.length, 1);
  children[0]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the first tunnel to come up');

  // cloudflared going away on its own is the case the operator never sees: the
  // link people have open stops working and nothing says so.
  children[0]!.emit('close', 1, null);
  await waitFor(() => children.length === 2, 'a reconnect');
  assert.ok(lines.some((line) => line.includes('reconnecting in')));
  children[1]!.stdout.write('INF |  https://spectrum-volleyball-melissa-cottage.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the replacement tunnel to come up');

  // Turning it off is a decision, not a fault, so nothing must reopen it.
  await tunnel.disable();
  assert.equal(tunnel.getState().mode, 'off');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(children.length, 2);
  await tunnel.close();
});

test('a tunnel that was on comes back when the manager starts again', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const spawnImpl = (() => fakeCloudflared() as unknown as ChildProcess) as unknown as typeof spawnType;
  const options = { paths, spawnImpl, env: { PATH: '' }, logger: () => undefined };

  // Nothing stored yet: a first start must not open anything by itself.
  assert.equal((await new TunnelManager(options).resume()).mode, 'off');

  const first = new TunnelManager(options);
  await first.start('quick');
  // The manager going down is not the operator turning the tunnel off.
  await first.close();

  const second = new TunnelManager(options);
  assert.equal((await second.resume()).mode, 'quick');
  await second.disable();

  // ...and once it is off, it stays off across a restart too.
  assert.equal((await new TunnelManager(options).resume()).mode, 'off');
});
