import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { ActivityMeter, CONSOLE_GAP_MS, SAMPLE_INTERVAL_MS, parseUsageDay } from '../src/activity.js';

async function meter(clock: { now: number }, running: () => boolean = () => false): Promise<{ meter: ActivityMeter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-activity-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  return { meter: new ActivityMeter({ paths, now: () => new Date(clock.now), sillyTavernRunning: running }), root };
}

test('the manager’s own uptime is counted, and SillyTavern’s separately', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  let running = false;
  const { meter: activity } = await meter(clock, () => running);
  await activity.start();

  // Ten minutes with SillyTavern off, then ten with it on.
  for (let tick = 0; tick < 10; tick += 1) { clock.now += SAMPLE_INTERVAL_MS; await activity.sample(); }
  running = true;
  for (let tick = 0; tick < 10; tick += 1) { clock.now += SAMPLE_INTERVAL_MS; await activity.sample(); }

  const summary = await activity.summary();
  assert.equal(summary.totals.managerSeconds, 1200);
  assert.equal(summary.totals.sillyTavernSeconds, 600);
  assert.equal(summary.totals.starts, 1);
});

test('a gap longer than a poll is somebody who left, not somebody watching', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { meter: activity } = await meter(clock);
  await activity.start();

  // The console polling as it does: the first request starts the clock, the
  // ones after it each add the time since the last.
  activity.seen();
  for (let poll = 0; poll < 10; poll += 1) { clock.now += 8_000; activity.seen(); }
  await activity.sample();
  assert.equal((await activity.summary()).totals.consoleSeconds, 80);

  // The tab is closed and opened again an hour later. The hour is not time
  // anybody spent looking at this.
  clock.now += 60 * 60 * 1000;
  activity.seen();
  clock.now += 8_000;
  activity.seen();
  await activity.sample();
  assert.equal((await activity.summary()).totals.consoleSeconds, 88);
  assert.ok(CONSOLE_GAP_MS < 60 * 60 * 1000);
});

test('a manager killed without warning loses a sample, not a day', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const first = await meter(clock);
  await first.meter.start();
  for (let tick = 0; tick < 5; tick += 1) { clock.now += SAMPLE_INTERVAL_MS; await first.meter.sample(); }

  // Nothing is closed: the process simply ends. What was written stays.
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: first.root } });
  const again = new ActivityMeter({ paths, now: () => new Date(clock.now), sillyTavernRunning: () => false });
  await again.start();
  const summary = await again.summary();
  assert.equal(summary.totals.managerSeconds, 300);
  assert.equal(summary.totals.starts, 2, 'both starts are counted');
});

test('only finished days are handed to telemetry, and only once', async () => {
  const clock = { now: Date.parse('2026-09-19T23:50:00.000Z') };
  const { meter: activity } = await meter(clock);
  await activity.start();
  clock.now += SAMPLE_INTERVAL_MS;
  await activity.sample();
  // Still the nineteenth: a day being added to would be sent, then sent again
  // with more in it, and nothing downstream could tell which to believe.
  await assert.rejects(readFile(activity.logPath, 'utf8'));

  clock.now = Date.parse('2026-09-20T00:30:00.000Z');
  await activity.sample();
  const written = (await readFile(activity.logPath, 'utf8')).split('\n').filter(Boolean);
  assert.equal(written.length, 1);
  assert.equal(parseUsageDay(JSON.parse(written[0] ?? '{}'))?.date, '2026-09-19');

  // Another day passes; the nineteenth is not offered a second time.
  clock.now = Date.parse('2026-09-21T00:30:00.000Z');
  await activity.sample();
  const after = (await readFile(activity.logPath, 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual(after.map((line) => parseUsageDay(JSON.parse(line))?.date), ['2026-09-19', '2026-09-20']);
});

test('a reading that could not be true is not kept', () => {
  assert.equal(parseUsageDay({ date: 'yesterday' }), null);
  assert.equal(parseUsageDay({ date: '2026-09-19', managerSeconds: -5 })?.managerSeconds, 0);
  // A day holds 86400 seconds however confused a clock is about it.
  assert.equal(parseUsageDay({ date: '2026-09-19', managerSeconds: 999_999 })?.managerSeconds, 86_400);
});
