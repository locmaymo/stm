import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { GoogleConnection, R2Manager, type SyncSource } from '../src/index.js';
import { hashFile } from '../src/sync.js';
import { fakeGoogle, type FakeGoogle } from './google-fake.js';

const CLIENT = { clientId: 'client-id.apps.example', redirectUri: 'https://relay.example/oauth/google/callback', brokerUrl: 'https://broker.example' };
const PREFIX = 'sillytavern-manager/';

interface Device { root: string; google: GoogleConnection; manager: R2Manager; profile: Profile }

/** The fake Drive stamps its files from 2026-10-16 on; the devices' clocks start an hour later. */
const clock = { now: Date.parse('2026-10-16T01:00:00.000Z') };

async function device(fake: FakeGoogle, label: string): Promise<Device> {
  const root = await mkdtemp(join(tmpdir(), 'stm-line-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const google = new GoogleConnection({ paths, client: CLIENT, fetchImpl: fake.fetchImpl, sleep: async () => undefined });
  const manager = new R2Manager({
    paths, env: { STM_DATA_DIR: root }, logger: () => undefined, google, installationLabel: label,
    // Moves on with every reading, so no two recovery points share a name.
    now: () => new Date((clock.now += 7)),
    slot: { settleMs: 0, sleep: async () => undefined },
  });
  manager.noteInstallation(`install-${label}`);
  const url = new URL(google.beginConnect('http://127.0.0.1:7860'));
  await google.completeConnect({ state: url.searchParams.get('state') ?? '', code: fake.issueCode(url.searchParams.get('code_challenge') ?? '') });
  await manager.update({ mode: 'google', enabled: true });
  // Every device makes its own profile, so the ids never match.
  const profile: Profile = {
    id: `profile-${label}`, name: 'Default', installationId: 'install-1', runtimePath: '/runtime', configPath: '/runtime/config.yaml',
    dataPath: '/runtime/data', layout: 'data', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
  return { root, google, manager, profile };
}

async function source(root: string, name: string, body: string): Promise<SyncSource> {
  const path = join(root, name.replaceAll('/', '-'));
  await writeFile(path, body);
  const file = await hashFile(name, path);
  assert.ok(file);
  return { file, path };
}

function names(fake: FakeGoogle, part: string): string[] {
  return [...fake.files.values()].map((file) => file.name).filter((name) => name.startsWith(`${PREFIX}${part}`)).sort();
}

/** A desk that shares its data and has sent it once, and a phone that has joined and caught up. */
async function pair(fake: FakeGoogle): Promise<{ desk: Device; phone: Device; chat: SyncSource }> {
  const desk = await device(fake, 'desk');
  await desk.manager.takeOwnership();
  await desk.manager.startSharing(desk.profile.id);
  const chat = await source(desk.root, 'chats/A/talk.jsonl', 'hello from the desk\n');
  await desk.manager.syncProfile({ profile: desk.profile, sources: [chat], fingerprint: 'desk-1' });
  const phone = await device(fake, 'phone');
  await phone.manager.takeOwnership();
  await phone.manager.joinSharing(phone.profile.id);
  const head = await phone.manager.sharedHead();
  assert.ok(head);
  await phone.manager.adoptShared(head, (await phone.manager.readShared(head)).files);
  return { desk, phone, chat };
}

test('a device that starts sharing sends its data as the first state of the line', async () => {
  const fake = fakeGoogle();
  const desk = await device(fake, 'desk');
  await desk.manager.takeOwnership();
  assert.equal((await desk.manager.getConfig()).sync, null);
  await desk.manager.startSharing(desk.profile.id);
  assert.equal((await desk.manager.getConfig()).sync?.state, 'ready');
  assert.equal((await desk.manager.getConfig()).sync?.generation, 0);

  const chat = await source(desk.root, 'chats/A/talk.jsonl', 'hello\n');
  const sent = await desk.manager.syncProfile({ profile: desk.profile, sources: [chat], fingerprint: 'one' });
  const place = await desk.manager.syncPlace();
  assert.equal(place?.seq, 1);
  assert.equal(place?.snapshotId, sent.snapshot.id);
  assert.equal(place?.files?.length, 1);
  // The line took the profile's id, so what was already sent under it is on the line.
  assert.deepEqual(names(fake, 'snapshots/'), [`${PREFIX}snapshots/profile-desk/${sent.snapshot.id}.json.gz`]);
  assert.deepEqual(names(fake, 'sync/'), [`${PREFIX}sync/gen/0000000001.json`, `${PREFIX}sync/head.json`, `${PREFIX}sync/line.json`]);
  const status = (await desk.manager.getConfig()).sync;
  assert.equal(status?.generation, 1);
  assert.equal(status?.writtenBy, 'desk');
  // None of it is somebody's old archive to be offered for deletion.
  assert.equal((await desk.manager.inspect()).legacyObjectCount, 0);
});

test('signing in on a second device does not take shared storage away from the first', async () => {
  const fake = fakeGoogle();
  const desk = await device(fake, 'desk');
  await desk.manager.takeOwnership();
  await desk.manager.startSharing(desk.profile.id);
  const chat = await source(desk.root, 'chats/A/talk.jsonl', 'hello\n');
  await desk.manager.syncProfile({ profile: desk.profile, sources: [chat], fingerprint: 'one' });

  const phone = await device(fake, 'phone');
  await phone.manager.takeOwnership();
  const invited = (await phone.manager.getConfig()).sync;
  assert.equal(invited?.state, 'invited');
  assert.equal(invited?.ahead?.label, 'desk');
  // Until it joins it neither sends nor is told it owns anything.
  const mine = await source(phone.root, 'chats/B/other.jsonl', 'from the phone\n');
  await assert.rejects(phone.manager.syncProfile({ profile: phone.profile, sources: [mine], fingerprint: 'p' }), { code: 'sync_join_required' });
  await phone.manager.refreshClaim();

  // The desk goes on as before: not signed out, not refused.
  const more = await source(desk.root, 'chats/A/talk.jsonl', 'hello\nand more\n');
  await desk.manager.syncProfile({ profile: desk.profile, sources: [more], fingerprint: 'two' });
  await desk.manager.refreshClaim();
  assert.equal((await desk.google.status()).state, 'connected');
  assert.equal((await phone.google.status()).state, 'connected');
  assert.equal((await desk.manager.syncPlace())?.seq, 2);
});

test('a device that joined sends nothing as the newest state until it has caught up', async () => {
  const fake = fakeGoogle();
  const desk = await device(fake, 'desk');
  await desk.manager.takeOwnership();
  await desk.manager.startSharing(desk.profile.id);
  const chat = await source(desk.root, 'chats/A/talk.jsonl', 'hello\n');
  const first = await desk.manager.syncProfile({ profile: desk.profile, sources: [chat], fingerprint: 'one' });

  const phone = await device(fake, 'phone');
  await phone.manager.takeOwnership();
  await phone.manager.joinSharing(phone.profile.id);
  assert.equal((await phone.manager.getConfig()).sync?.state, 'catching_up');
  const mine = await source(phone.root, 'chats/B/other.jsonl', 'from the phone\n');
  await assert.rejects(phone.manager.syncProfile({ profile: phone.profile, sources: [mine], fingerprint: 'p' }), { code: 'sync_behind' });

  // Its own data can still be put in storage, as a recovery point and nothing more.
  const kept = await phone.manager.syncProfile({ profile: phone.profile, sources: [mine], fingerprint: 'p', generation: false });
  assert.equal(kept.snapshot.profileId, 'profile-desk');
  assert.equal((await phone.manager.syncPlace())?.seq, 0);
  assert.equal(names(fake, 'sync/gen/').length, 1);

  const head = await phone.manager.sharedHead();
  assert.equal(head?.seq, 1);
  assert.equal(head?.snapshotId, first.snapshot.id);
  assert.equal(head?.device.label, 'desk');
  const files = (await phone.manager.readShared(head!)).files;
  assert.deepEqual(files.map((file) => file.name), ['chats/A/talk.jsonl']);
  await phone.manager.adoptShared(head!, files);
  assert.equal((await phone.manager.getConfig()).sync?.state, 'ready');
  assert.equal(await phone.manager.sharedHead(), null);

  // The recovery points of both devices are one list now.
  assert.equal((await phone.manager.listSnapshots(phone.profile.id)).length, 2);
  assert.equal((await desk.manager.listSnapshots(desk.profile.id)).length, 2);
});

test('the device that was left behind is told who moved on, and stops sending', async () => {
  const fake = fakeGoogle();
  const { desk, phone, chat } = await pair(fake);
  const reply = await source(phone.root, 'chats/A/talk.jsonl', 'hello from the desk\nand from the phone\n');
  await phone.manager.syncProfile({ profile: phone.profile, sources: [reply], fingerprint: 'phone-1' });
  assert.equal((await phone.manager.syncPlace())?.seq, 2);

  // The desk was not told; it finds out when it reaches for the same number.
  const stale = await source(desk.root, 'chats/A/talk.jsonl', 'hello from the desk\nmeanwhile at the desk\n');
  const before = names(fake, 'snapshots/').length;
  await assert.rejects(desk.manager.syncProfile({ profile: desk.profile, sources: [stale], fingerprint: 'desk-2' }), { code: 'sync_superseded' });
  // What it sent is still there to be read back when it catches up.
  assert.equal(names(fake, 'snapshots/').length, before + 1);
  const status = (await desk.manager.getConfig()).sync;
  assert.equal(status?.state, 'catching_up');
  assert.equal(status?.ahead?.label, 'phone');
  assert.equal(status?.generation, 1);
  await assert.rejects(desk.manager.syncProfile({ profile: desk.profile, sources: [chat], fingerprint: 'desk-3' }), { code: 'sync_behind' });
  // One file per number: the desk's attempt at number 2 is gone.
  assert.deepEqual(names(fake, 'sync/gen/'), [`${PREFIX}sync/gen/0000000001.json`, `${PREFIX}sync/gen/0000000002.json`]);

  const head = await desk.manager.sharedHead();
  assert.equal(head?.seq, 2);
  await desk.manager.adoptShared(head!, (await desk.manager.readShared(head!)).files);
  await desk.manager.syncProfile({ profile: desk.profile, sources: [stale], fingerprint: 'desk-4' });
  assert.equal((await desk.manager.syncPlace())?.seq, 3);
  // And the phone learns of it without sending anything.
  assert.equal((await phone.manager.sharedHead())?.seq, 3);
  assert.equal((await phone.manager.getConfig()).sync?.state, 'catching_up');
});

test('a device far behind finds the head from the hint, past the numbers that were tidied away', async () => {
  const fake = fakeGoogle();
  const { desk, phone } = await pair(fake);
  for (let turn = 2; turn <= 26; turn += 1) {
    const chat = await source(desk.root, 'chats/A/talk.jsonl', `line ${String(turn)}\n`);
    await desk.manager.syncProfile({ profile: desk.profile, sources: [chat], fingerprint: `desk-${String(turn)}` });
  }
  assert.equal((await desk.manager.syncPlace())?.seq, 26);
  // Twenty numbers are kept behind the head.
  assert.equal(names(fake, 'sync/gen/')[0], `${PREFIX}sync/gen/0000000007.json`);
  assert.equal((await phone.manager.syncPlace())?.seq, 1);
  assert.equal((await phone.manager.sharedHead())?.seq, 26);
});

test('a sweep of shared storage leaves fresh chunks alone, and the other device reads its list again', async () => {
  const fake = fakeGoogle();
  const { desk, phone } = await pair(fake);
  await desk.manager.update({ keepRecent: 1, keepDaily: 1, keepWeekly: 0 });

  // The phone has a card in storage that no recovery point will name soon.
  const card = await source(phone.root, 'characters/Old.png', 'a card that is about to be deleted');
  const chat = await source(phone.root, 'chats/A/talk.jsonl', 'hello from the desk\n');
  await phone.manager.syncProfile({ profile: phone.profile, sources: [chat, card], fingerprint: 'phone-1' });
  const hash = card.file.chunks[0]!.hash;
  await phone.manager.syncProfile({ profile: phone.profile, sources: [chat], fingerprint: 'phone-2' });

  const head = await desk.manager.sharedHead();
  await desk.manager.adoptShared(head!, (await desk.manager.readShared(head!)).files);
  const later = await source(desk.root, 'chats/A/talk.jsonl', 'hello from the desk\nlater\n');
  await desk.manager.syncProfile({ profile: desk.profile, sources: [later], fingerprint: 'desk-2' });
  assert.ok((await desk.manager.pruneSnapshots(desk.profile.id)).length > 0);
  assert.equal((await desk.manager.listSnapshots(desk.profile.id)).length, 1);

  // Nothing names the card now, but it was stored a moment ago.
  const soon = await desk.manager.reconcile();
  assert.equal(soon.collectedBlobs, 0);
  await desk.manager.readBlob(hash);
  assert.equal(names(fake, 'sync/sweep.json').length, 0);

  clock.now += 3 * 24 * 60 * 60 * 1000;
  try {
    const swept = await desk.manager.reconcile();
    assert.ok(swept.collectedBlobs >= 1);
    await assert.rejects(desk.manager.readBlob(hash));
    assert.equal(names(fake, 'sync/sweep.json').length, 1);

    // The phone still believes the card's chunk is stored. Told of the sweep, it sends it again.
    const caught = await phone.manager.sharedHead();
    await phone.manager.adoptShared(caught!, (await phone.manager.readShared(caught!)).files);
    assert.equal((await phone.manager.syncPlace())?.sweep, null);
    await phone.manager.syncProfile({ profile: phone.profile, sources: [later, card], fingerprint: 'phone-3' });
    assert.notEqual((await phone.manager.syncPlace())?.sweep, null);
    assert.equal((await phone.manager.readBlob(hash)).toString('utf8'), 'a card that is about to be deleted');
  } finally {
    clock.now -= 3 * 24 * 60 * 60 * 1000;
  }
});

test('a device that stops sharing leaves the line for the others', async () => {
  const fake = fakeGoogle();
  const { desk, phone } = await pair(fake);
  await phone.manager.stopSharing();
  assert.equal(await phone.manager.syncPlace(), null);
  assert.equal(names(fake, 'sync/line.json').length, 1);
  const more = await source(desk.root, 'chats/A/talk.jsonl', 'hello from the desk\nstill here\n');
  await desk.manager.syncProfile({ profile: desk.profile, sources: [more], fingerprint: 'desk-2' });
  assert.equal((await desk.manager.syncPlace())?.seq, 2);
});
