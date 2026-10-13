import test from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeCommandStatus } from '../../../packages/contracts/src/index.js';
import { runInSillyTavern } from '../src/st-bridge.js';

const id = '11111111-1111-4111-8111-111111111111';
const command = { kind: 'slash', command: '/profile Work' } as const;

function status(state: BridgeCommandStatus['state'], tabs: number, result: BridgeCommandStatus['result'] = null): BridgeCommandStatus {
  return { id, state, result, tabs };
}

/** A manager that answers each request with the next of `answers`, recording what was asked. */
function manager(answers: Array<Response | Error>): { fetch: (input: string, init?: RequestInit) => Promise<Response>; asked: Array<{ input: string; init: RequestInit | undefined }> } {
  const asked: Array<{ input: string; init: RequestInit | undefined }> = [];
  return {
    asked,
    fetch: async (input, init) => {
      asked.push({ input, init });
      const next = answers.shift();
      if (!next) throw new Error('asked more than expected');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const json = (body: unknown, init: ResponseInit = { status: 200 }) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } });

test('a command goes to the manager with the CSRF token, and the tab’s answer comes back', async () => {
  const fake = manager([json(status('delivered', 1), { status: 202 }), json(status('done', 1, { ok: true, value: 'Work' }))]);
  const waiting: boolean[] = [];
  const result = await runInSillyTavern(command, { csrfToken: 'csrf', fetch: fake.fetch, onWaiting: (value) => waiting.push(value) });
  assert.deepEqual(result, { ok: true, value: 'Work' });
  assert.deepEqual(waiting, [], 'a tab was open, so nobody is told to open one');
  assert.equal(fake.asked[0]?.input, '/api/v1/sillytavern/bridge/commands');
  assert.equal(fake.asked[0]?.init?.method, 'POST');
  assert.equal((fake.asked[0]?.init?.headers as Record<string, string>)['x-csrf-token'], 'csrf');
  assert.equal(fake.asked[0]?.init?.body, JSON.stringify(command));
  assert.equal(fake.asked[1]?.input, `/api/v1/sillytavern/bridge/commands/${id}?wait=25`);
});

test('with no tab open the reader is told, and told again when one takes it', async () => {
  const fake = manager([
    json(status('waiting', 0), { status: 202 }),
    json(status('waiting', 0)),
    json(status('delivered', 1)),
    json(status('done', 1, { ok: false, error: 'not_ready' })),
  ]);
  const waiting: boolean[] = [];
  const result = await runInSillyTavern(command, { csrfToken: 'csrf', fetch: fake.fetch, onWaiting: (value) => waiting.push(value) });
  assert.deepEqual(result, { ok: false, error: 'not_ready' });
  assert.deepEqual(waiting, [true, false]);
});

test('a command nobody took ends as expired', async () => {
  const fake = manager([json(status('waiting', 0), { status: 202 }), json(status('expired', 0, { ok: false, error: 'expired' }))]);
  const waiting: boolean[] = [];
  assert.deepEqual(await runInSillyTavern(command, { csrfToken: 'csrf', fetch: fake.fetch, onWaiting: (value) => waiting.push(value) }), { ok: false, error: 'expired' });
  assert.deepEqual(waiting, [true, false]);
});

test('a refusal from the manager is its code', async () => {
  const fake = manager([json({ error: { code: 'invalid_command', message: 'no' } }, { status: 400 })]);
  assert.deepEqual(await runInSillyTavern(command, { csrfToken: 'csrf', fetch: fake.fetch }), { ok: false, error: 'invalid_command' });
});

test('a dropped connection is retried, and three in a row give up', async () => {
  const recovered = manager([json(status('delivered', 1), { status: 202 }), new TypeError('network'), json(status('done', 1, { ok: true, value: '' }))]);
  assert.deepEqual(await runInSillyTavern(command, { csrfToken: 'csrf', fetch: recovered.fetch, retryMs: 1 }), { ok: true, value: '' });
  const lost = manager([json(status('delivered', 1), { status: 202 }), new TypeError('a'), new TypeError('b'), new TypeError('c')]);
  await assert.rejects(runInSillyTavern(command, { csrfToken: 'csrf', fetch: lost.fetch, retryMs: 1 }), /c/u);
});

test('stopping the wait withdraws the command, so it does not run when a tab opens later', async () => {
  const controller = new AbortController();
  const fake = manager([json(status('waiting', 0), { status: 202 }), new DOMException('aborted', 'AbortError'), json({ cancelled: true })]);
  const result = runInSillyTavern(command, { csrfToken: 'csrf', fetch: fake.fetch, signal: controller.signal, onWaiting: () => controller.abort() });
  await assert.rejects(result);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.asked[2]?.input, `/api/v1/sillytavern/bridge/commands/${id}`);
  assert.equal(fake.asked[2]?.init?.method, 'DELETE');
  assert.equal((fake.asked[2]?.init?.headers as Record<string, string>)['x-csrf-token'], 'csrf');
});
