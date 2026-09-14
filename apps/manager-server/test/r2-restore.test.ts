import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { BackupStore } from '../../../packages/backup/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import { CHUNK_BYTES } from '../../../packages/r2/src/sync.js';
import type { Profile } from '../../../packages/contracts/src/index.js';
import { fetchSnapshotToLibrary } from '../src/r2-restore.js';
import { syncProfileToR2 } from '../src/r2-scheduler.js';

/** An in-memory bucket that answers the parts of S3 this manager speaks. */
function fakeBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort()
        .map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(name)?.byteLength ?? 0}</Size><LastModified>2026-09-14T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') { objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer())); return new Response('', { status: 200 }); }
    if (method === 'GET') {
      const body = objects.get(key);
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('<Error/>', { status: 404 });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects };
}

async function createWorld(): Promise<{ profile: Profile; backups: BackupStore; r2: R2Manager; dataRoot: string; objects: Map<string, Buffer> }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-r2-restore-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  const dataRoot = join(runtimePath, 'data', 'default-user');
  await mkdir(join(dataRoot, 'chats'), { recursive: true });
  await mkdir(join(dataRoot, 'characters'), { recursive: true });
  await mkdir(join(dataRoot, 'thumbnails'), { recursive: true });
  const profile: Profile = {
    id: 'profile-1', name: 'Default', installationId: 'install-1', runtimePath,
    configPath: join(runtimePath, 'config.yaml'), dataPath: join(runtimePath, 'data'), layout: 'data',
    active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
  const bucket = fakeBucket();
  const backups = new BackupStore({ paths, logger: () => undefined });
  const r2 = new R2Manager({ paths, env: {}, logger: () => undefined, fetchImpl: bucket.fetchImpl });
  await r2.update({
    endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'stm-test-bucket',
    accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678', enabled: true,
  });
  return { profile, backups, r2, dataRoot, objects: bucket.objects };
}

test('a recovery point comes back from R2 as an archive the existing restore accepts', async () => {
  const { profile, backups, r2, dataRoot } = await createWorld();
  // A profile with the shapes that matter: a chat past one chunk so the
  // reassembly has to put two of them back in the right order, a binary card
  // that must survive byte for byte, an empty file, and a cache that should
  // never have been sent at all.
  const chat = Buffer.concat([Buffer.alloc(CHUNK_BYTES, 'a'), Buffer.from('the last line\n')]);
  const card = randomBytes(4096);
  await writeFile(join(dataRoot, 'settings.json'), '{"theme":"dark"}', 'utf8');
  await writeFile(join(dataRoot, 'chats', 'long.jsonl'), chat);
  await writeFile(join(dataRoot, 'characters', 'Trợ lý.png'), card);
  await writeFile(join(dataRoot, 'chats', 'empty.jsonl'), '');
  await writeFile(join(dataRoot, 'thumbnails', 'cached.png'), 'regenerable');

  await syncProfileToR2({ profile, backups, r2, tier: 'cold' });
  const snapshots = await r2.listSnapshots(profile.id);
  assert.equal(snapshots.length, 1);

  const fetched = await fetchSnapshotToLibrary({ profile, r2, backups, snapshotId: snapshots[0]!.id });
  assert.equal(fetched.manifest.source, 'uploaded');
  // The preview is what the restore flow shows before it writes anything. If
  // it does not recognise this as a SillyTavern profile, nothing else matters.
  assert.equal(fetched.preview.fileCount, 4);
  assert.ok(fetched.preview.files.some((entry) => entry.name.endsWith('settings.json')));

  // Restoring it into an emptied profile has to put back exactly what was
  // there - including the multi-chunk file and the non-ASCII name.
  const archivePath = await backups.getArchivePath(fetched.manifest.id);
  assert.ok(archivePath);
  await rm(dataRoot, { recursive: true, force: true });
  await backups.restore(profile, archivePath, { mode: 'replace' });

  assert.equal(await readFile(join(dataRoot, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.deepEqual(await readFile(join(dataRoot, 'chats', 'long.jsonl')), chat);
  assert.deepEqual(await readFile(join(dataRoot, 'characters', 'Trợ lý.png')), card);
  assert.equal(await readFile(join(dataRoot, 'chats', 'empty.jsonl'), 'utf8'), '');
  // The cache was never uploaded, so it is not restored either.
  await assert.rejects(() => readFile(join(dataRoot, 'thumbnails', 'cached.png'), 'utf8'));
});

test('a frequent backup can be restored whole, images and all', async () => {
  const { profile, backups, r2, dataRoot } = await createWorld();
  await mkdir(join(dataRoot, 'user', 'images'), { recursive: true });
  const image = randomBytes(2048);
  await writeFile(join(dataRoot, 'settings.json'), '{"a":1}', 'utf8');
  await writeFile(join(dataRoot, 'user', 'images', 'photo.png'), image);
  await syncProfileToR2({ profile, backups, r2, tier: 'cold' });

  // The five-minute run never looks at the image. The recovery point it writes
  // still has to be able to put it back, or the frequent tier is not a backup.
  await writeFile(join(dataRoot, 'chats', 'new.jsonl'), 'hello\n', 'utf8');
  await syncProfileToR2({ profile, backups, r2, tier: 'hot' });

  const snapshots = await r2.listSnapshots(profile.id);
  assert.equal(snapshots.length, 2);
  const fetched = await fetchSnapshotToLibrary({ profile, r2, backups, snapshotId: snapshots[0]!.id });
  const archivePath = await backups.getArchivePath(fetched.manifest.id);
  assert.ok(archivePath);
  await rm(dataRoot, { recursive: true, force: true });
  await backups.restore(profile, archivePath, { mode: 'replace' });

  assert.deepEqual(await readFile(join(dataRoot, 'user', 'images', 'photo.png')), image);
  assert.equal(await readFile(join(dataRoot, 'chats', 'new.jsonl'), 'utf8'), 'hello\n');
});

test('a recovery point whose chunks are gone fails instead of restoring a hole', async () => {
  const { profile, backups, r2, dataRoot, objects } = await createWorld();
  await writeFile(join(dataRoot, 'settings.json'), '{"a":1}', 'utf8');
  await syncProfileToR2({ profile, backups, r2, tier: 'cold' });
  const snapshots = await r2.listSnapshots(profile.id);

  // Someone emptied the bucket by hand. Half an archive presented as a whole
  // one is worse than no archive at all.
  for (const key of [...objects.keys()]) if (key.includes('/blobs/')) objects.delete(key);
  await assert.rejects(() => fetchSnapshotToLibrary({ profile, r2, backups, snapshotId: snapshots[0]!.id }), /404|failed/u);
  assert.equal((await backups.list(profile.id)).length, 0);
});
