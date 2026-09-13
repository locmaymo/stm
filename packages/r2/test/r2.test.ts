import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { BackupManifest } from '../../contracts/src/index.js';
import { R2Manager } from '../src/index.js';

function manifest(): BackupManifest {
  return { schemaVersion: 1, id: 'backup-1', name: 'Default-2026.zip', createdAt: '2026-09-11T00:00:00.000Z', profileId: 'profile-1', profileName: 'Default', layout: 'data', sizeBytes: 0, checksumSha256: 'abc', fileCount: 1, source: 'created', fingerprint: 'fingerprint-1' };
}

test('R2 config masks credentials and preserves ******** updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-r2-config-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root } });
  await manager.update({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'stm-test-bucket', accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678', enabled: true });
  const before = await manager.getConfig();
  assert.equal(before.configured, true);
  assert.equal(before.accessKeyIdMasked, 'ac********34');
  assert.equal(before.secretAccessKeyConfigured, true);
  await manager.update({ accessKeyId: '********', secretAccessKey: '********' });
  const after = await manager.getConfig();
  assert.equal(after.accessKeyIdMasked, before.accessKeyIdMasked);
  assert.equal(after.secretAccessKeyConfigured, true);
});

test('R2 uploads use SigV4 and switch to multipart above 64 MiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-r2-upload-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const uploaded = new Map<string, number>();
  const multipartParts = new Map<string, number>();
  let multipartStarts = 0;
  let multipartCompletes = 0;
  let requests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests += 1;
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    assert.match(headers.get('authorization') ?? '', /AWS4-HMAC-SHA256 Credential=access-key-1234\//u);
    assert.equal(headers.get('x-amz-content-sha256'), 'UNSIGNED-PAYLOAD');
    if (method === 'GET') {
      const contents = [...uploaded.entries()].map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size><LastModified>2026-09-11T00:00:00.000Z</LastModified><ETag>"etag"</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult>${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'POST' && url.searchParams.has('uploads')) {
      multipartStarts += 1;
      return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>', { status: 200 });
    }
    if (method === 'PUT' && url.searchParams.has('partNumber')) {
      multipartParts.set(`${url.pathname}:${url.searchParams.get('partNumber')}`, Number(headers.get('content-length')));
      return new Response('', { status: 200, headers: { etag: `"part-${url.searchParams.get('partNumber')}"` } });
    }
    if (method === 'POST' && url.searchParams.has('uploadId')) {
      multipartCompletes += 1;
      const total = [...multipartParts.entries()].filter(([key]) => key.startsWith(url.pathname)).reduce((sum, [, size]) => sum + size, 0);
      uploaded.set(decodeURIComponent(url.pathname.split('/').slice(2).join('/')), total);
      return new Response('', { status: 200 });
    }
    if (method === 'PUT') {
      uploaded.set(decodeURIComponent(url.pathname.split('/').slice(2).join('/')), Number(headers.get('content-length')));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') return new Response('', { status: 204 });
    return new Response('', { status: 200 });
  };
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root }, fetchImpl });
  await manager.update({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'stm-test-bucket', accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678', enabled: true, maxBackups: 7 });
  const small = join(root, 'small.zip');
  await writeFile(small, Buffer.alloc(8));
  await manager.uploadArchive(small, { ...manifest(), sizeBytes: 8 }, 'fingerprint-small');
  assert.equal(multipartStarts, 0);
  const large = join(root, 'large.zip');
  await writeFile(large, Buffer.alloc(0));
  await truncate(large, 64 * 1024 * 1024 + 1);
  await manager.uploadArchive(large, { ...manifest(), id: 'backup-large', sizeBytes: 64 * 1024 * 1024 + 1 }, 'fingerprint-large');
  assert.equal(multipartStarts, 1);
  assert.equal(multipartCompletes, 1);
  assert.ok(requests >= 8);
});
