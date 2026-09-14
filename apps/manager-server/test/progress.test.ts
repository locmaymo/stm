import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferMeter, formatDuration } from '../src/progress.js';
import { formatBytes } from '../../../packages/contracts/src/index.js';

test('a transfer too young to have a rate says so rather than inventing one', () => {
  let clock = 1_000;
  const meter = new TransferMeter({ now: () => clock });
  clock += 100;
  const first = meter.update({ completedBytes: 1_000, totalBytes: 10 * 1024 * 1024, completedItems: 1, totalItems: 10 });
  assert.equal(first.params.rate, '—');
  assert.equal(first.params.eta, '—');
});

test('a transfer reports how fast it is going and how much longer', () => {
  let clock = 0;
  const meter = new TransferMeter({ now: () => clock });

  // 1 MiB/s: half of a 10 MiB transfer done in five seconds, so five to go.
  clock = 5_000;
  const half = meter.update({ completedBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, completedItems: 5, totalItems: 10 });
  assert.equal(half.params.rate, '1.0 MB/s');
  assert.equal(half.params.eta, '0:05');
  assert.equal(Math.round(half.percent), 50);
  assert.equal(half.params.done, '5.2 MB');
  assert.equal(half.params.total, '10.5 MB');
});

test('the rate follows a connection that slows down instead of the whole average', () => {
  let clock = 0;
  const meter = new TransferMeter({ now: () => clock });
  // Twenty seconds at 10 MiB/s, then a second at 1 MiB/s. Averaging over the
  // whole transfer would still claim nearly 10 and be wrong about the wait.
  for (let second = 1; second <= 20; second += 1) {
    clock = second * 1000;
    meter.update({ completedBytes: second * 10 * 1024 * 1024, totalBytes: 400 * 1024 * 1024, completedItems: second, totalItems: 40 });
  }
  for (let second = 21; second <= 25; second += 1) {
    clock = second * 1000;
    meter.update({ completedBytes: (200 + (second - 20)) * 1024 * 1024, totalBytes: 400 * 1024 * 1024, completedItems: second, totalItems: 40 });
  }
  const slowed = meter.update({ completedBytes: 205 * 1024 * 1024, totalBytes: 400 * 1024 * 1024, completedItems: 25, totalItems: 40 });
  assert.ok(Number.parseFloat(String(slowed.params.rate)) < 9, `expected the rate to fall, got ${String(slowed.params.rate)}`);
});

test('a transfer that has not moved says so rather than guessing', () => {
  let clock = 0;
  const meter = new TransferMeter({ now: () => clock });
  clock += 30_000;
  const stalled = meter.update({ completedBytes: 0, totalBytes: 1024, completedItems: 0, totalItems: 1 });
  assert.equal(stalled.params.rate, '—');
  assert.equal(stalled.params.eta, '—');
});

test('sizes and durations read the same in any language', () => {
  // Decimal, because that is what Cloudflare quotes a bucket in and what a
  // network rate is measured in everywhere. Binary maths with a "GB" label is
  // how the panel and the Cloudflare dashboard came to disagree by seven
  // percent about the same bucket.
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1000), '1.0 kB');
  assert.equal(formatBytes(3_379_086_928), '3.4 GB');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3_725), '1:02:05');
});
