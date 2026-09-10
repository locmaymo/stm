import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import { RuntimeError, RuntimeManager, extractZipSafely } from '../src/index.js';

function zip(entries: Array<{ name: string; body: string }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = Buffer.from(entry.body, 'utf8');
    const compressed = deflateRawSync(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 14); header.writeUInt32LE(0, 18); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(compressed.length, 22); header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    // Correct the CRC and sizes after writing fixed-width fields.
    header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(body.length, 22);
    local.push(header, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(body), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(body.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const localBuffer = Buffer.concat(local); const centralBuffer = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(localBuffer.length, 16);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  return new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate a test port')); return; }
      server.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

test('version discovery keeps latest, release, staging, and tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtime = new RuntimeManager({ paths, fetch: async () => new Response(JSON.stringify([{ tag_name: '1.2.3', name: 'v1.2.3', published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false }] ), { status: 200 }) });
  const versions = await runtime.listVersions();
  assert.deepEqual(versions.slice(0, 3).map((item) => item.selector), ['latest', 'release', 'staging']);
  assert.equal(versions[0]?.label, 'v1.2.3 (latest)');
  assert.equal(versions[3]?.selector, '1.2.3');
});

test('safe extraction strips GitHub root and rejects zip slip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-extract-'));
  const archive = join(root, 'source.zip');
  await writeFile(archive, zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"SillyTavern"}' }, { name: 'SillyTavern-abc/配置/角色.txt', body: 'xin chào' }]));
  const destination = join(root, 'out');
  await extractZipSafely(archive, destination);
  assert.equal(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).name, 'SillyTavern');
  assert.equal(await readFile(join(destination, '配置', '角色.txt'), 'utf8'), 'xin chào');
  await writeFile(archive, zip([{ name: '../escape.txt', body: 'blocked' }]));
  await assert.rejects(() => extractZipSafely(archive, destination), (error: unknown) => error instanceof RuntimeError && error.code === 'unsafe_archive');
});

test('successful installation writes marker only after dependency install and activates it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-success-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]);
  let dependencyInstallCalled = false;
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => { dependencyInstallCalled = true; },
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'ready');
  assert.equal(dependencyInstallCalled, true);
  assert.equal((await stat(installation.markerPath)).isFile(), true);
  assert.equal((await runtime.getActiveInstallation())?.id, installation.id);
});

test('failed npm install never leaves an installation marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"SillyTavern","scripts":{"start":"node server.js"}}' }]);
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => { throw new RuntimeError('npm_failed', 'dependency install failed'); },
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'failed');
  await assert.rejects(() => stat(installation.markerPath));
});

test('health check prepares a data root for older SillyTavern runtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-health-check-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const port = await freePort();
  const archive = zip([
    { name: 'SillyTavern-legacy/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' },
    {
      name: 'SillyTavern-legacy/server.js',
      body: [
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv;",
        "const dataRoot = args[args.indexOf('--dataRoot') + 1];",
        "const port = Number(args[args.indexOf('--port') + 1]);",
        "fs.writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), 'test-secret');",
        "http.createServer((_request, response) => response.end('ok')).listen(port, '127.0.0.1');",
      ].join('\n'),
    },
  ]);
  const runtime = new RuntimeManager({
    paths,
    healthCheckPort: port,
    healthCheckTimeoutMs: 5_000,
    installDependencies: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.13.2', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'ready');
  assert.equal((await stat(installation.markerPath)).isFile(), true);
  await assert.rejects(() => stat(join(installation.runtimePath, '.health-check-data')));
});

test('health check forwards startup diagnostics when a runtime exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-health-failure-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const port = await freePort();
  const archive = zip([
    { name: 'SillyTavern-legacy/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' },
    { name: 'SillyTavern-legacy/server.js', body: "console.error('legacy boot failed'); process.exit(1);" },
  ]);
  const lines: string[] = [];
  const runtime = new RuntimeManager({
    paths,
    healthCheckPort: port,
    healthCheckTimeoutMs: 5_000,
    installDependencies: async () => undefined,
    logger: (line) => lines.push(line),
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.13.2', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'failed');
  assert.match(installation.error ?? '', /legacy boot failed/u);
  assert.ok(lines.some((line) => line.includes('legacy boot failed')));
});

test('only one installation job runs at a time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-busy-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  let release: (() => void) | undefined;
  const runtime = new RuntimeManager({ paths, healthCheck: async () => undefined, installDependencies: async () => new Promise<void>((resolvePromise) => { release = resolvePromise; }), fetch: async (input) => input.toString().includes('/releases') ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }])) : new Response(new Uint8Array(zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]))) });
  const first = runtime.queueInstall('latest');
  assert.throws(() => runtime.queueInstall('staging'), (error: unknown) => error instanceof RuntimeError && error.code === 'installation_busy');
  while (!release) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  release?.();
  await first.promise;
});
