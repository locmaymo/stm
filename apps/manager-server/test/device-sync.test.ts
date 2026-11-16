import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { BackupStore } from '../../../packages/backup/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import { hashFile } from '../../../packages/r2/src/sync.js';
import type { Profile } from '../../../packages/contracts/src/index.js';
import { catchUp, DeviceSync } from '../src/device-sync.js';
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
        .map((name) => `<Contents><Key>${name.replace(/&/gu, '&amp;')}</Key><Size>${objects.get(name)?.byteLength ?? 0}</Size><LastModified>2026-09-14T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') {
      if (new Headers(init?.headers as HeadersInit).get('if-none-match') === '*' && objects.has(key)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer()));
      return new Response('', { status: 200 });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('<Error/>', { status: 404 });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects };
}

interface Device {
  readonly label: string;
  readonly profile: Profile;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly data: string;
  readonly state: string;
  write(name: string, body: string): Promise<void>;
  read(name: string): Promise<string | null>;
  names(): Promise<string[]>;
  /** Send what is here as the newest state of the shared data. */
  send(): Promise<void>;
  catchUp(platform?: NodeJS.Platform): ReturnType<typeof catchUp>;
}

let clock = Date.parse('2026-11-16T07:00:00.000Z');

async function device(bucket: { fetchImpl: typeof fetch }, label: string): Promise<Device> {
  const root = await mkdtemp(join(tmpdir(), 'stm-device-sync-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  const data = join(runtimePath, 'data', 'default-user');
  await mkdir(data, { recursive: true });
  const profile: Profile = {
    id: `profile-${label}`, name: 'Default', installationId: 'install-1', runtimePath,
    configPath: join(runtimePath, 'config.yaml'), dataPath: join(runtimePath, 'data'), layout: 'data',
    active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
  const backups = new BackupStore({ paths, logger: () => undefined });
  const r2 = new R2Manager({
    paths, env: {}, logger: () => undefined, fetchImpl: bucket.fetchImpl, installationLabel: label,
    // A minute on with every reading, so no two recovery points or copies share a name.
    now: () => new Date((clock += 60_000)),
    slot: { settleMs: 0, sleep: async () => undefined },
  });
  r2.noteInstallation(`install-${label}`);
  await r2.update({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'stm-test-bucket', accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678', enabled: true });
  const walk = async (directory: string, prefix: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(...await walk(join(directory, entry.name), `${prefix}${entry.name}/`));
      else found.push(`${prefix}${entry.name}`);
    }
    return found;
  };
  return {
    label, profile, backups, r2, data, state: paths.state,
    write: async (name, body) => { await mkdir(dirname(join(data, name)), { recursive: true }); await writeFile(join(data, name), body, 'utf8'); },
    read: async (name) => await readFile(join(data, name), 'utf8').catch(() => null),
    names: async () => (await walk(data, '')).sort(),
    send: async () => { await syncProfileToR2({ profile, backups, r2, tier: 'cold' }); },
    catchUp: async (platform = 'linux') => await catchUp({ profile, r2, backups, platform, now: () => new Date(2026, 10, 16, 14, 5) }),
  };
}

/** A desk sharing a small profile, and a phone that joined and caught up with it. */
async function pair(): Promise<{ desk: Device; phone: Device; bucket: ReturnType<typeof fakeBucket> }> {
  const bucket = fakeBucket();
  const desk = await device(bucket, 'desk');
  await desk.write('settings.json', '{"theme":"dark"}');
  await desk.write('chats/Seraphina/first.jsonl', 'hello\n');
  await desk.write('characters/Seraphina.png', 'card');
  await desk.r2.startSharing(desk.profile.id);
  await desk.send();
  const phone = await device(bucket, 'phone');
  await phone.r2.joinSharing(phone.profile.id);
  await phone.catchUp();
  return { desk, phone, bucket };
}

test('a device with nothing joins and comes away with everything', async () => {
  const bucket = fakeBucket();
  const desk = await device(bucket, 'desk');
  await desk.write('settings.json', '{"theme":"dark"}');
  await desk.write('chats/Seraphina/first.jsonl', 'hello\n');
  await desk.write('characters/Trợ lý.png', 'card');
  await desk.r2.startSharing(desk.profile.id);
  await desk.send();

  const phone = await device(bucket, 'phone');
  await phone.r2.joinSharing(phone.profile.id);
  assert.equal((await phone.r2.getConfig()).sync?.state, 'catching_up');
  const result = await phone.catchUp();
  assert.equal(result.outcome?.taken, 3);
  assert.equal(result.outcome?.from, 'desk');
  assert.equal(result.outcome?.recoveryPoint, null);
  assert.equal(result.push, false);
  assert.deepEqual(await phone.names(), ['characters/Trợ lý.png', 'chats/Seraphina/first.jsonl', 'settings.json']);
  assert.equal(await phone.read('chats/Seraphina/first.jsonl'), 'hello\n');
  assert.equal((await phone.r2.getConfig()).sync?.state, 'ready');
  // Nothing more to do the second time.
  assert.deepEqual(await phone.catchUp(), { outcome: null, push: false });
});

test('what one device changed arrives on the other, deletions included', async () => {
  const { desk, phone } = await pair();
  await phone.write('chats/Seraphina/first.jsonl', 'hello\nhi from the phone\n');
  await phone.write('chats/Seraphina/second.jsonl', 'a new chat\n');
  await rm(join(phone.data, 'characters', 'Seraphina.png'));
  await phone.send();

  const result = await desk.catchUp();
  assert.equal(result.outcome?.taken, 2);
  assert.equal(result.outcome?.removed, 1);
  assert.deepEqual(result.outcome?.keptBoth, []);
  assert.equal(result.push, false);
  assert.equal(await desk.read('chats/Seraphina/first.jsonl'), 'hello\nhi from the phone\n');
  // The folder the last file left goes with it.
  assert.deepEqual(await desk.names(), ['chats/Seraphina/first.jsonl', 'chats/Seraphina/second.jsonl', 'settings.json']);
  // And the desk, sending again, does not send the phone's files back as changes.
  const before = (await desk.r2.syncPlace())?.seq;
  await desk.send();
  assert.equal((await desk.r2.syncPlace())?.seq, (before ?? 0) + 1);
  assert.deepEqual(await phone.catchUp().then((caught) => [caught.outcome?.taken, caught.outcome?.removed]), [0, 0]);
});

test('a chat both devices wrote to is kept twice, and settings take the other device with a copy kept', async () => {
  const { desk, phone } = await pair();
  // The phone was offline; the desk was used meanwhile and sent first.
  await desk.write('chats/Seraphina/first.jsonl', 'hello\nsaid at the desk\n');
  await desk.write('settings.json', '{"theme":"light"}');
  await desk.write('stats.json', '{"desk":1}');
  await desk.send();
  await phone.write('chats/Seraphina/first.jsonl', 'hello\nsaid on the phone, longer\n');
  await phone.write('settings.json', '{"theme":"dark","font":"big"}');
  // Rewritten by SillyTavern on every device, every time: taken, and not worth a word.
  await phone.write('stats.json', '{"phone":2}');
  await phone.write('chats/Seraphina/only-phone.jsonl', 'never seen by the desk\n');

  const result = await phone.catchUp();
  const copy = 'chats/Seraphina/first (phone 2026-11-16 14-05).jsonl';
  assert.deepEqual(result.outcome?.keptBoth, [copy]);
  assert.deepEqual(result.outcome?.setAside, ['settings.json']);
  assert.equal(result.push, true);
  assert.equal(await phone.read('chats/Seraphina/first.jsonl'), 'hello\nsaid at the desk\n');
  assert.equal(await phone.read(copy), 'hello\nsaid on the phone, longer\n');
  assert.equal(await phone.read('settings.json'), '{"theme":"light"}');
  assert.equal(await phone.read('stats.json'), '{"desk":1}');
  assert.equal(await phone.read('chats/Seraphina/only-phone.jsonl'), 'never seen by the desk\n');

  // The settings that lost are in a recovery point taken before anything was replaced.
  assert.ok(result.outcome?.recoveryPoint);
  const kept = await phone.r2.readSnapshot(phone.profile.id, result.outcome.recoveryPoint);
  const settings = kept.files.find((file) => file.name === 'settings.json');
  assert.ok(settings);
  assert.equal((await phone.r2.readBlob(settings.chunks[0]!.hash)).toString('utf8'), '{"theme":"dark","font":"big"}');

  // Sent on, the second chat reaches the desk as a chat of its own.
  await phone.send();
  const back = await desk.catchUp();
  assert.deepEqual(back.outcome?.keptBoth, []);
  assert.equal(await desk.read(copy), 'hello\nsaid on the phone, longer\n');
  assert.equal(await desk.read('chats/Seraphina/only-phone.jsonl'), 'never seen by the desk\n');
  assert.deepEqual(await desk.names(), await phone.names());
});

test('a chat that is the other one with more said stays one chat', async () => {
  const bucket = fakeBucket();
  const desk = await device(bucket, 'desk');
  await desk.write('chats/A/longer-at-desk.jsonl', 'one\ntwo\n');
  await desk.write('chats/A/longer-on-phone.jsonl', 'one\n');
  await desk.write('chats/A/same-length-start.jsonl', 'one\nTWO\n');
  await desk.r2.startSharing(desk.profile.id);
  await desk.send();

  // The phone has data of its own from before it joined: nothing says who changed what.
  const phone = await device(bucket, 'phone');
  await phone.write('chats/A/longer-at-desk.jsonl', 'one\n');
  await phone.write('chats/A/longer-on-phone.jsonl', 'one\ntwo\nthree\n');
  await phone.write('chats/A/same-length-start.jsonl', 'one\ntwo\nthree\n');
  await phone.r2.joinSharing(phone.profile.id);
  const result = await phone.catchUp();

  assert.equal(await phone.read('chats/A/longer-at-desk.jsonl'), 'one\ntwo\n');
  assert.equal(await phone.read('chats/A/longer-on-phone.jsonl'), 'one\ntwo\nthree\n');
  // Longer, but not the same beginning: two chats.
  assert.deepEqual(result.outcome?.keptBoth, ['chats/A/same-length-start (phone 2026-11-16 14-05).jsonl']);
  assert.equal(await phone.read('chats/A/same-length-start.jsonl'), 'one\nTWO\n');
  assert.equal(result.push, true);
  assert.equal((await phone.names()).length, 4);
});

test('the second copy of a group chat is added to the group that lists the first', async () => {
  const { desk, phone } = await pair();
  await desk.write('groups/1700000000000.json', JSON.stringify({ id: '1700000000000', name: 'Party', chats: ['2026-11-01@10h00m00s'] }));
  await desk.write('group chats/2026-11-01@10h00m00s.jsonl', 'start\n');
  await desk.send();
  await phone.catchUp();

  await desk.write('group chats/2026-11-01@10h00m00s.jsonl', 'start\ndesk\n');
  await desk.send();
  await phone.write('group chats/2026-11-01@10h00m00s.jsonl', 'start\nphone side\n');
  const result = await phone.catchUp();
  const copy = '2026-11-01@10h00m00s (phone 2026-11-16 14-05)';
  assert.deepEqual(result.outcome?.keptBoth, [`group chats/${copy}.jsonl`]);
  const group = JSON.parse(await phone.read('groups/1700000000000.json') ?? '{}') as { chats: string[]; name: string };
  assert.deepEqual(group.chats, ['2026-11-01@10h00m00s', copy]);
  assert.equal(group.name, 'Party');
});

test('a catch-up cut short leaves whole files and is finished by the next one', async () => {
  const { desk, phone } = await pair();
  await desk.write('chats/Seraphina/first.jsonl', 'hello\nmore\n');
  await desk.write('chats/Seraphina/second.jsonl', 'another\n');
  await desk.write('worlds/Lore.json', '{"entries":{}}');
  await desk.send();

  const readBlob = phone.r2.readBlob.bind(phone.r2);
  let reads = 0;
  phone.r2.readBlob = async (hash: string, name?: string): Promise<Buffer> => {
    reads += 1;
    if (reads === 2) throw new Error('the network went away');
    return await readBlob(hash, name);
  };
  await assert.rejects(phone.catchUp(), /network went away/u);
  phone.r2.readBlob = readBlob;
  // Nothing half written, nothing left beside the files, and nothing agreed to yet.
  assert.equal((await phone.names()).some((name) => name.includes('.stm-sync-')), false);
  for (const name of await phone.names()) assert.ok(['hello\n', 'hello\nmore\n', 'another\n', '{"entries":{}}', '{"theme":"dark"}', 'card'].includes(await phone.read(name) ?? ''));
  assert.equal((await phone.r2.syncPlace())?.seq, 1);
  assert.equal((await phone.r2.getConfig()).sync?.state, 'catching_up');

  const result = await phone.catchUp();
  assert.deepEqual(result.outcome?.keptBoth, []);
  assert.deepEqual(await phone.names(), await desk.names());
  assert.equal(await phone.read('chats/Seraphina/first.jsonl'), 'hello\nmore\n');
  assert.equal((await phone.r2.syncPlace())?.seq, 2);
});

test('a name this device cannot hold is skipped, and is not sent on as a deletion', async () => {
  const { desk, phone } = await pair();
  // Written by a device whose file system allows it; this one is asked to behave like Windows.
  const body = join(desk.data, 'stand-in.txt');
  await writeFile(body, 'asked at half past\n', 'utf8');
  const odd = await hashFile('chats/Seraphina/10:30?.jsonl', body);
  assert.ok(odd);
  await rm(body);
  const base = (await desk.r2.syncPlace())?.files ?? [];
  await desk.r2.syncProfile({ profile: desk.profile, sources: [], carried: [...base, odd], fingerprint: 'with-odd-name' });

  const result = await phone.catchUp('win32');
  assert.deepEqual(result.outcome?.skipped, ['chats/Seraphina/10:30?.jsonl']);
  assert.equal(result.push, false);
  assert.equal((await phone.names()).some((name) => name.includes('10')), false);

  await phone.write('chats/Seraphina/first.jsonl', 'hello\nfrom the phone\n');
  await phone.send();
  const sent = await phone.r2.syncPlace();
  assert.ok(sent?.files?.some((file) => file.name === 'chats/Seraphina/10:30?.jsonl'));
  // Catching up again does not read the missing file as this device deleting it.
  assert.deepEqual(await phone.catchUp('win32'), { outcome: null, push: false });
});

test('sitting down at a device stops SillyTavern on the one that was in use', async () => {
  const { desk, phone } = await pair();
  const stops: string[] = [];
  const running = { desk: true, phone: false };
  const sharing = (target: Device, who: 'desk' | 'phone'): DeviceSync => new DeviceSync({
    r2: target.r2, backups: target.backups, stateDirectory: target.state,
    isRunning: () => running[who],
    stop: async () => { stops.push(who); running[who] = false; },
  });
  const atDesk = sharing(desk, 'desk');
  const onPhone = sharing(phone, 'phone');

  // Nothing has happened: the desk is the one in use and stays running.
  await atDesk.watch();
  assert.deepEqual(stops, []);

  // The phone is opened. It has nothing to take in, and says it is in use now.
  await onPhone.beforeStart(phone.profile);
  running.phone = true;
  assert.equal((await phone.r2.syncPlace())?.mine, true);
  await atDesk.watch();
  assert.deepEqual(stops, ['desk']);
  assert.equal((await desk.r2.getConfig()).sync?.state, 'catching_up');
  assert.equal((await desk.r2.getConfig()).sync?.ahead?.label, 'phone');
  // Said once, not every minute.
  await atDesk.watch();
  assert.deepEqual(stops, ['desk']);

  // Back at the desk: it catches up, takes its turn, and the phone stops.
  await phone.write('chats/Seraphina/first.jsonl', 'hello\nfrom the phone\n');
  await phone.send();
  await atDesk.beforeStart(desk.profile);
  running.desk = true;
  assert.equal(await desk.read('chats/Seraphina/first.jsonl'), 'hello\nfrom the phone\n');
  await onPhone.watch();
  assert.deepEqual(stops, ['desk', 'phone']);
});

test('a device that cannot reach storage starts on what it has, and what it changed is kept later', async () => {
  const { desk, phone, bucket } = await pair();
  const reach = bucket.fetchImpl;
  let offline = true;
  // The same bucket object is what both devices were built on, so this is the phone's network only.
  const lines: string[] = [];
  const onPhone = new DeviceSync({ r2: phone.r2, backups: phone.backups, stateDirectory: phone.state, isRunning: () => false, stop: async () => undefined, logger: (line) => { lines.push(typeof line === 'string' ? line : line.code); } });
  const original = phone.r2.sharedHead.bind(phone.r2);
  phone.r2.sharedHead = async () => { if (offline) throw new Error('fetch failed'); return await original(); };
  await onPhone.beforeStart(phone.profile);
  assert.deepEqual(lines, ['sync.catchUpFailed']);
  await phone.write('chats/Seraphina/first.jsonl', 'hello\nwritten offline\n');

  await desk.write('chats/Seraphina/first.jsonl', 'hello\nwritten at the desk\n');
  await desk.send();
  offline = false;
  await onPhone.beforeStart(phone.profile);
  assert.equal(await phone.read('chats/Seraphina/first.jsonl'), 'hello\nwritten at the desk\n');
  assert.equal((await phone.names()).filter((name) => name.startsWith('chats/Seraphina/first (phone ')).length, 1);
  const outcome = await onPhone.outcome();
  assert.equal(outcome?.keptBoth.length, 1);
  await onPhone.dismissOutcome();
  assert.equal(await onPhone.outcome(), null);
  assert.equal(typeof reach, 'function');
});
