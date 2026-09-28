import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { AnnouncementFeed } from '../src/announcements.js';
import { NotificationCenter, renderNotification } from '../src/notifications.js';

test('news from the project reaches the bell once, and nothing odd gets in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-announce-'));
  const center = new NotificationCenter({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } }) });
  const asked: string[] = [];
  const answer = {
    schemaVersion: 1,
    announcements: [
      { id: 'a2', createdAt: '2026-09-28T10:00:00.000Z', level: 'warning', title: { en: 'Update soon', vi: 'Sắp cập nhật' }, body: { en: 'Please update.', vi: 'Hãy cập nhật.' }, url: 'https://stm.example/news' },
      { id: 'a1', createdAt: '2026-09-27T10:00:00.000Z', level: 'info', title: { en: 'Hello', vi: 'Xin chào' }, body: { en: 'Welcome.', vi: 'Chào mừng.' }, url: null },
      { id: 'a3', createdAt: '2026-09-27T10:00:00.000Z', level: 'info', title: { en: 'Sneaky', vi: '' }, body: { en: 'x', vi: 'x' }, url: 'javascript:alert(1)' },
    ],
  };
  const feed = new AnnouncementFeed({
    center,
    url: 'https://receiver.example/v1/announcements',
    platform: 'windows',
    version: '1.1.0',
    fetch: (async (url: string) => { asked.push(url); return new Response(JSON.stringify(answer), { status: 200 }); }) as unknown as typeof globalThis.fetch,
  });

  assert.equal(await feed.check(), 2);
  assert.equal(await feed.check(), 0, 'read back, but already said');
  // Only the platform and the version go with the question.
  assert.equal(asked[0], 'https://receiver.example/v1/announcements?platform=windows&version=1.1.0');
  const items = (await center.list()).items;
  assert.deepEqual(items.map((item) => item.broadcast?.title.en), ['Update soon', 'Hello']);
  assert.equal(items[0]?.level, 'warning');
  assert.deepEqual([renderNotification(items[0]!, 'vi').title, renderNotification(items[0]!, 'vi').url], ['Sắp cập nhật', 'https://stm.example/news']);
});

test('a receiver that is down or answers nonsense is simply no news', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-announce-'));
  const center = new NotificationCenter({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } }) });
  const down = new AnnouncementFeed({ center, url: 'https://receiver.example/v1/announcements', platform: 'linux', version: '1.1.0', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch });
  assert.equal(await down.check(), 0);
  const odd = new AnnouncementFeed({ center, url: 'https://receiver.example/v1/announcements', platform: 'linux', version: '1.1.0', fetch: (async () => new Response('<html>', { status: 200 })) as unknown as typeof globalThis.fetch });
  assert.equal(await odd.check(), 0);
  assert.equal(center.summary().unread, 0);
});
