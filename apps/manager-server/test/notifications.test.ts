import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logEvent, type Job, type ManagerNotification } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { NotificationCenter, NotificationRules, renderNotification, type NotificationRulesDeps } from '../src/notifications.js';

async function center(now: () => Date = () => new Date('2026-09-28T10:00:00.000Z')): Promise<{ center: NotificationCenter; paths: ReturnType<typeof getPlatformPaths> }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-notify-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  return { center: new NotificationCenter({ paths, now }), paths };
}

function rules(bell: NotificationCenter, overrides: Partial<NotificationRulesDeps> = {}): NotificationRules {
  return new NotificationRules({
    center: bell,
    tunnelDown: () => false,
    freeBytes: async () => null,
    cloudUse: async () => null,
    sillyTavernUpdate: async () => null,
    managerUpdate: async () => null,
    tunnelGraceMs: 10,
    ...overrides,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('the bell keeps what it was told across a restart, and counts what is unread', async () => {
  const { center: bell, paths } = await center();
  await bell.emit('installFinished', 'success', { params: { ref: '1.19.0' } });
  const second = await bell.emit('sillytavernCrashed', 'error', { params: { detail: 'code 1' } });
  assert.deepEqual(bell.summary(), { unread: 2, latestId: second?.id });

  const again = new NotificationCenter({ paths });
  const list = await again.list();
  assert.deepEqual(list.items.map((item) => item.kind), ['sillytavernCrashed', 'installFinished']);
  assert.equal((await again.markRead([second!.id])).unread, 1);
  assert.equal((await again.markRead()).unread, 0);
  await again.clear();
  assert.deepEqual(again.summary(), { unread: 0, latestId: null });
});

test('the same thing is said once per window, however often it happens', async () => {
  let clock = Date.parse('2026-09-28T10:00:00.000Z');
  const { center: bell } = await center(() => new Date(clock));
  assert.ok(await bell.emit('backupFailed', 'error', { dedupeKey: 'backupFailed', dedupeMs: 60_000 }));
  assert.equal(await bell.emit('backupFailed', 'error', { dedupeKey: 'backupFailed', dedupeMs: 60_000 }), null);
  clock += 61_000;
  assert.ok(await bell.emit('backupFailed', 'error', { dedupeKey: 'backupFailed', dedupeMs: 60_000 }));
  // No window at all is once for good: an update is announced once.
  assert.ok(await bell.emit('managerUpdate', 'info', { dedupeKey: 'managerUpdate:1.2.0' }));
  clock += 30 * 24 * 60 * 60 * 1000;
  assert.equal(await bell.emit('managerUpdate', 'info', { dedupeKey: 'managerUpdate:1.2.0' }), null);
});

test('a notification is put into words in the language asked for', () => {
  const failed: ManagerNotification = { id: 'n1', kind: 'operationFailed', level: 'error', createdAt: '2026-09-28T10:00:00.000Z', readAt: null, params: { job: 'r2Upload', reason: 'network down' } };
  assert.deepEqual([renderNotification(failed, 'vi').title, renderNotification(failed, 'vi').body], ['Sao lưu lên cloud không thành công', 'network down']);
  assert.equal(renderNotification(failed, 'en').title, 'The cloud backup did not finish');
  const news: ManagerNotification = { id: 'n2', kind: 'broadcast', level: 'info', createdAt: '2026-09-28T10:00:00.000Z', readAt: null, broadcast: { title: { en: 'Hello', vi: 'Xin chào' }, body: { en: 'Body', vi: '' }, url: 'https://stm.example/news' } };
  const rendered = renderNotification(news, 'vi');
  // A missing translation falls back to the English it was written in.
  assert.deepEqual([rendered.title, rendered.body, rendered.url], ['Xin chào', 'Body', 'https://stm.example/news']);
});

test('what the manager logs rings the bell, and backups working again is said once', async () => {
  const { center: bell } = await center();
  const watch = rules(bell);
  watch.onLog(logEvent('sillytavern.exited', '[sillytavern] exited on its own (code 1)', { detail: 'code 1' }));
  watch.onLog(logEvent('backup.scheduleSkipped', '[backup] scheduled backup skipped: disk full', { reason: 'disk full' }));
  watch.onLog(logEvent('backup.scheduleSkipped', '[backup] scheduled backup skipped: bucket gone', { reason: 'bucket gone' }));
  watch.onLog(logEvent('backup.r2Synced', '[backup] synced', { tier: 'hot', chunks: 1, files: 1 }));
  watch.onLog(logEvent('backup.r2Synced', '[backup] synced', { tier: 'hot', chunks: 1, files: 1 }));
  watch.onLog('a plain line from SillyTavern itself');
  await settle();
  const kinds = (await bell.list()).items.map((item) => item.kind).reverse();
  assert.deepEqual(kinds, ['sillytavernCrashed', 'backupFailed', 'backupRecovered']);
});

test('another device taking the data over is told as a pause, not as a crash', async () => {
  const { center: bell } = await center();
  const watch = rules(bell);
  watch.onLog(logEvent('sync.handedOver', '[sync] Pixel-7 is using this data now, so SillyTavern was stopped here', { label: 'Pixel-7' }));
  // What the supervisor writes as it stops it: a stop it was asked for.
  watch.onLog(logEvent('sillytavern.stoppedUsedElsewhere', '[sillytavern] stopped: another of your devices is using this data'));
  await settle();
  const items = (await bell.list()).items;
  assert.deepEqual(items.map((item) => [item.kind, item.level]), [['sillytavernPaused', 'info']], 'one calm word, and no crash');
  const said = renderNotification(items[0] as ManagerNotification, 'vi');
  assert.equal(said.title, 'SillyTavern tạm dừng ở máy này');
  assert.ok(said.body.startsWith('Pixel-7 đang dùng dữ liệu của bạn.'), said.body);
  assert.ok(renderNotification(items[0] as ManagerNotification, 'en').body.includes('“Use it on this device”'));

  // An address the machine was named by is shortened to its two ends, as the console does.
  const { center: other } = await center();
  rules(other).onLog(logEvent('sync.handedOver', '[sync] handed over', { label: 'a-very-long-studio-name-1234567890.hosted.example' }));
  await settle();
  assert.equal((await other.list()).items[0]?.params?.device, 'a-very-long-...sted.example');
});

test('running out of memory is said as that, with the file that most likely filled it', async () => {
  const { center: bell } = await center();
  rules(bell, { largestFile: async () => ({ name: 'chats/Seraphina/long.jsonl', bytes: 180 * 1024 * 1024 }) })
    .onLog(logEvent('sillytavern.outOfMemory', '[sillytavern] ran out of the 1077 MiB of memory it may use and stopped (signal SIGABRT)', { heap: 1077, detail: 'signal SIGABRT' }));
  await settle();
  const items = (await bell.list()).items;
  assert.deepEqual(items.map((item) => [item.kind, item.level]), [['sillytavernOutOfMemory', 'error']]);
  const said = renderNotification(items[0] as ManagerNotification, 'vi');
  assert.equal(said.title, 'SillyTavern hết bộ nhớ');
  assert.ok(said.body.includes('1077 MB') && said.body.includes('chats/Seraphina/long.jsonl (180 MB)'), said.body);

  // With no file to point at, it is still a crash, said the old way.
  const { center: other } = await center();
  rules(other, { largestFile: async () => null }).onLog(logEvent('sillytavern.outOfMemory', '[sillytavern] ran out', { heap: 1077, detail: 'signal SIGABRT' }));
  await settle();
  assert.deepEqual((await other.list()).items.map((item) => [item.kind, item.params?.detail]), [['sillytavernCrashed', 'signal SIGABRT']]);
});

test('a dropped tunnel is only news once it has stayed down', async () => {
  const { center: bell } = await center();
  let down = false;
  const watch = rules(bell, { tunnelDown: () => down });
  watch.onLog(logEvent('cloudflared.exited', '[cloudflared] exited on its own', { detail: 'code 1' }));
  await settle();
  assert.equal(bell.summary().unread, 0, 'it came straight back');
  down = true;
  watch.onLog(logEvent('cloudflared.exited', '[cloudflared] exited on its own', { detail: 'code 1' }));
  await settle();
  assert.deepEqual((await bell.list()).items.map((item) => item.kind), ['tunnelDown']);
});

test('jobs somebody started say how they ended, and a stopped one says nothing', async () => {
  const { center: bell } = await center();
  const watch = rules(bell);
  const job = (kind: Job['kind'], state: Job['state']): Job => ({ id: `job-${kind}-${state}`, kind, state, progress: 100, step: '', installationId: null, createdAt: '', updatedAt: '', error: state === 'failed' ? 'no room' : null });
  watch.onJob(job('r2Upload', 'succeeded'));
  watch.onJob(job('restore', 'failed'));
  watch.onJob(job('backup', 'canceled'));
  watch.onJob(job('installation', 'succeeded'));
  await settle();
  const items = [...(await bell.list()).items].reverse();
  assert.deepEqual(items.map((item) => item.kind), ['cloudBackupDone', 'operationFailed']);
  assert.deepEqual(items[1]?.params, { job: 'restore', reason: 'no room' });
});

test('the slow clock tells of space, the cloud allowance and new releases, each once', async () => {
  const { center: bell } = await center();
  const watch = rules(bell, {
    freeBytes: async () => ({ free: 500 * 1024 ** 2, total: 64 * 1024 ** 3 }),
    cloudUse: async () => ({ storage: 0.5, writes: 0.93, reads: 0.1 }),
    sillyTavernUpdate: async () => '1.20.0',
    managerUpdate: async () => null,
    now: () => new Date('2026-09-28T10:00:00.000Z'),
  });
  await watch.look();
  await watch.look();
  const items = [...(await bell.list()).items].reverse();
  assert.deepEqual(items.map((item) => item.kind), ['diskLow', 'cloudQuota', 'sillytavernUpdate']);
  assert.deepEqual(items[1]?.params, { percent: 93, what: 'writes' });
  assert.equal(renderNotification(items[0]!, 'en').body, 'Only 500.0 MB is left where the manager keeps your data.');
});
