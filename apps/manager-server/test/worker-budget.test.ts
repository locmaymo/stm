import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerBudget, WORKER_BUDGET_STEPS, easesPolling, withholdsAddress } from '../src/worker-budget.js';
import type { WorkersUsageReport } from '../../../packages/cloudflare/src/index.js';
import type { CloudflareConnection } from '../../../packages/r2/src/index.js';
import type { LogEvent, LogLine } from '../../../packages/contracts/src/index.js';

const LIMIT = 100_000;

function report(requests: number, at: Date): WorkersUsageReport {
  const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return {
    dayStart: dayStart.toISOString(),
    measuredAt: at.toISOString(),
    requests,
    errors: 0,
    scripts: [{ scriptName: 'sillytavern', requests, errors: 0 }],
    freeTier: { requestsPerDay: LIMIT },
  };
}

interface Harness {
  readonly budget: WorkerBudget;
  readonly clock: { now: Date };
  readonly usage: { requests: number };
  readonly reads: () => number;
  readonly codes: () => string[];
  /** Let the refresh this started finish, since it is deliberately not awaited. */
  readonly settle: () => Promise<void>;
}

function harness(options: { connected?: boolean; analytics?: boolean; failing?: boolean } = {}): Harness {
  const clock = { now: new Date('2026-09-22T12:00:00Z') };
  const usage = { requests: 0 };
  let reads = 0;
  const codes: string[] = [];
  const cloudflare = {
    status: async () => ({
      state: options.connected === false ? 'disconnected' : 'connected',
      analyticsGranted: options.analytics !== false,
      account: { id: '0123456789abcdef0123456789abcdef', name: 'Acme' },
    }),
    cloudflareApi: () => ({}),
  } as unknown as CloudflareConnection;
  const budget = new WorkerBudget({
    cloudflare,
    now: () => clock.now,
    logger: (line: LogLine) => { codes.push((line as LogEvent).code ?? ''); },
    read: async () => {
      reads += 1;
      if (options.failing) throw new Error('not authorized for that account');
      return report(usage.requests, clock.now);
    },
  });
  return {
    budget,
    clock,
    usage,
    reads: () => reads,
    codes: () => codes,
    settle: async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test('nothing is given up while the day has room', async () => {
  const { budget, usage, settle } = harness();
  usage.requests = 12_000;
  budget.refresh();
  await settle();

  assert.equal(budget.level(), 'clear');
  assert.equal(easesPolling('clear'), false);
  assert.equal(withholdsAddress('clear', 'manager'), false);
  assert.equal(withholdsAddress('clear', 'sillyTavern'), false);
  assert.equal(budget.state().requests, 12_000);
});

test('what is given up, and the order it goes in', () => {
  // The order is who notices. A slower screen is invisible; the console's own
  // address costs one person who has a local address anyway; SillyTavern's
  // address is the one that was shared, so it goes last.
  assert.equal(easesPolling('easing'), true);
  assert.equal(withholdsAddress('easing', 'manager'), false);
  assert.equal(withholdsAddress('easing', 'sillyTavern'), false);

  assert.equal(withholdsAddress('console', 'manager'), true);
  assert.equal(withholdsAddress('console', 'sillyTavern'), false);

  assert.equal(withholdsAddress('shared', 'manager'), true);
  assert.equal(withholdsAddress('shared', 'sillyTavern'), true);

  // And the steps themselves stay in that order.
  assert.ok(WORKER_BUDGET_STEPS.easing < WORKER_BUDGET_STEPS.console);
  assert.ok(WORKER_BUDGET_STEPS.console < WORKER_BUDGET_STEPS.shared);
  assert.ok(WORKER_BUDGET_STEPS.shared < 1);
});

test('each step is reached at the share of the day it names', async () => {
  const { budget, usage, clock, settle } = harness();
  const reach = async (requests: number) => {
    usage.requests = requests;
    // Past the slower of the two refresh intervals, so a reading is taken
    // whichever side of a step the last one landed on.
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    budget.refresh();
    await settle();
    return budget.level();
  };

  assert.equal(await reach(59_999), 'clear');
  assert.equal(await reach(60_000), 'easing');
  assert.equal(await reach(74_999), 'easing');
  assert.equal(await reach(75_000), 'console');
  assert.equal(await reach(89_999), 'console');
  assert.equal(await reach(90_000), 'shared');
  // Ten thousand requests are still left at the last step, which is roughly
  // thirty more SillyTavern page loads. The point is to arrive at the limit
  // having already stopped handing out the address, not to arrive at it.
  assert.equal(await reach(100_000), 'shared');
});

test('the day turning over gives the allowance back with no clock of its own', async () => {
  const { budget, usage, clock, settle } = harness();
  usage.requests = 96_000;
  budget.refresh();
  await settle();
  assert.equal(budget.level(), 'shared');

  // Midnight UTC, which in Vietnam is seven in the morning. The reading that
  // was taken is about an allowance that has since been given back, so it
  // stops counting - and until a new one is taken, nothing is withheld.
  clock.now = new Date('2026-09-23T00:01:00Z');
  assert.equal(budget.level(), 'clear');
  assert.equal(budget.state().requests, null);
});

test('a figure nobody can read is not a reason to take an address away', async () => {
  // Three ways the figure is unknown, all of which used to be indistinguishable
  // from zero and must not be indistinguishable from "nearly out". A manager
  // that quietly served tunnel addresses forever because a permission was
  // missing would have given up the feature it exists for.
  for (const options of [{ connected: false }, { analytics: false }, { failing: true }]) {
    const { budget, usage, settle } = harness(options);
    usage.requests = 99_000;
    budget.refresh();
    await settle();
    assert.equal(budget.level(), 'clear', JSON.stringify(options));
    assert.equal(budget.state().requests, null);
  }

  // And a manager with no Cloudflare sign-in at all never asks.
  const none = new WorkerBudget({ cloudflare: null });
  none.refresh();
  assert.equal(none.level(), 'clear');
});

test('a reading that stops being refreshed ages out rather than holding on', async () => {
  const { budget, usage, clock, settle } = harness();
  usage.requests = 92_000;
  budget.refresh();
  await settle();
  assert.equal(budget.level(), 'shared');

  // Still the same UTC day, but an hour with nothing confirming it. The query
  // may be down, and withholding an address on the strength of a figure that
  // nothing has stood behind for an hour is the wrong way to be wrong.
  clock.now = new Date(clock.now.getTime() + 61 * 60_000);
  assert.equal(budget.level(), 'clear');
});

test('the figure is asked for on its own clock, not on every request', async () => {
  const { budget, usage, clock, reads, settle } = harness();
  usage.requests = 1_000;
  for (let call = 0; call < 20; call += 1) { budget.refresh(); await settle(); }
  assert.equal(reads(), 1, 'a console polling four times a minute must not query Cloudflare four times a minute');

  // Fifteen minutes while there is room to spare.
  clock.now = new Date(clock.now.getTime() + 14 * 60_000);
  budget.refresh();
  await settle();
  assert.equal(reads(), 1);
  clock.now = new Date(clock.now.getTime() + 2 * 60_000);
  budget.refresh();
  await settle();
  assert.equal(reads(), 2);

  // Five once a step has been passed, where the next one matters sooner.
  usage.requests = 70_000;
  clock.now = new Date(clock.now.getTime() + 16 * 60_000);
  budget.refresh();
  await settle();
  assert.equal(budget.level(), 'easing');
  const afterEasing = reads();
  clock.now = new Date(clock.now.getTime() + 6 * 60_000);
  budget.refresh();
  await settle();
  assert.equal(reads(), afterEasing + 1);
});

test('the log says so once, on the way down and on the way back', async () => {
  const { budget, usage, clock, codes, settle } = harness();
  const move = async (requests: number) => {
    usage.requests = requests;
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    budget.refresh();
    await settle();
  };

  await move(10_000);
  assert.deepEqual(codes(), [], 'nothing is said while nothing is given up');

  await move(78_000);
  await move(79_000);
  assert.deepEqual(codes(), ['cloudflare.budgetConsole'], 'said once, not on every reading');

  await move(95_000);
  await move(4_000);
  assert.deepEqual(codes(), ['cloudflare.budgetConsole', 'cloudflare.budgetShared', 'cloudflare.budgetClear']);
});
