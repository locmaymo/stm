import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import { parseTunnelUrl, TunnelManager } from '../src/index.js';

const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

async function createPaths(): Promise<ReturnType<typeof getPlatformPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-'));
  return getPlatformPaths({ env: { STM_DATA_DIR: root } });
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
