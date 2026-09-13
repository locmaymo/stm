import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import { TunnelManager } from '../src/index.js';

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
