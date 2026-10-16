import test from 'node:test';
import assert from 'node:assert/strict';
import { answerTermuxOffer, appFeatures, bubbleRequest, hasAppChannel, importZipFromApp, openInApp, parseAppUpdateEvent, parseBubbleState, parseFeatures, parseImportEvent, updateApp } from '../src/app-bridge.js';

test('the app says whether replies are told, whether they bubble, and whether Android lets them float', () => {
  assert.deepEqual(parseBubbleState('{"type":"bubbles","replies":false,"enabled":true,"bubbles":true,"allowed":false}'), { replies: false, enabled: true, bubbles: true, allowed: false });
  // Replies are told unless the app says they are not.
  assert.deepEqual(parseBubbleState('{"type":"bubbles"}'), { replies: true, enabled: false, bubbles: false, allowed: false });
});

test('anything else on the channel is not an answer about bubbles', () => {
  for (const data of ['{"type":"sent","key":"c:a.png","problem":""}', 'not json', '"bubbles"', 'null', 42, null]) {
    assert.equal(parseBubbleState(data), null, String(data));
  }
});

test('a browser has no app to ask', async () => {
  assert.equal(hasAppChannel(), false);
  assert.equal(await bubbleRequest({ enabled: true }), null);
});

test('the app is asked on its channel, and its answer is what comes back', async () => {
  const sent: string[] = [];
  const listeners = new Set<(event: MessageEvent<string>) => void>();
  const channel = {
    postMessage(message: string) {
      sent.push(message);
      const reply = JSON.stringify({ type: 'bubbles', replies: true, enabled: true, bubbles: true, allowed: true });
      // Something unrelated first, the way a page may hear other messages.
      queueMicrotask(() => { for (const listener of [...listeners]) { listener({ data: '{"type":"sent"}' } as MessageEvent<string>); listener({ data: reply } as MessageEvent<string>); } });
    },
    addEventListener(_type: 'message', listener: (event: MessageEvent<string>) => void) { listeners.add(listener); },
    removeEventListener(_type: 'message', listener: (event: MessageEvent<string>) => void) { listeners.delete(listener); },
  };
  (globalThis as { STMApp?: unknown }).STMApp = channel;
  try {
    assert.equal(hasAppChannel(), true);
    assert.deepEqual(await bubbleRequest({ enabled: true }), { replies: true, enabled: true, bubbles: true, allowed: true });
    assert.deepEqual(sent.map((message) => JSON.parse(message) as unknown), [{ type: 'bubbles', enabled: true }]);
    assert.equal(listeners.size, 0);
  } finally {
    delete (globalThis as { STMApp?: unknown }).STMApp;
  }
});

test('an app that never answers is given up on', async () => {
  (globalThis as { STMApp?: unknown }).STMApp = { postMessage() {}, addEventListener() {}, removeEventListener() {} };
  try {
    assert.equal(await bubbleRequest({}, 20), null);
  } finally {
    delete (globalThis as { STMApp?: unknown }).STMApp;
  }
});

test('SillyTavern is handed to the app when there is one, and left to the page when there is not', () => {
  assert.equal(openInApp('http://127.0.0.1:8001/'), false);
  const sent: string[] = [];
  (globalThis as { STMApp?: unknown }).STMApp = { postMessage(message: string) { sent.push(message); }, addEventListener() {}, removeEventListener() {} };
  try {
    assert.equal(openInApp('http://127.0.0.1:8001/'), true);
    assert.deepEqual(sent.map((message) => JSON.parse(message) as unknown), [{ type: 'open', url: 'http://127.0.0.1:8001/' }]);
  } finally {
    delete (globalThis as { STMApp?: unknown }).STMApp;
  }
});

test('the app says what it can do, and anything it leaves out it cannot', () => {
  assert.deepEqual(parseFeatures('{"type":"features","importZip":true,"termux":true,"termuxOffer":false}'), { importZip: true, termux: true, termuxOffer: false, appUpdate: false });
  // An app from before Termux was asked about.
  assert.deepEqual(parseFeatures('{"type":"features","importZip":true}'), { importZip: true, termux: false, termuxOffer: false, appUpdate: false });
  assert.equal(parseFeatures('{"type":"bubbles"}'), null);
});

test('a failed import carries the code the page has words for', () => {
  assert.deepEqual(parseImportEvent('{"type":"import","state":"failed","code":"termux_not_found","message":"No SillyTavern"}'), { state: 'failed', message: 'No SillyTavern', code: 'termux_not_found' });
  assert.deepEqual(parseImportEvent('{"type":"import","state":"failed","message":"x","status":413,"body":"{}"}'), { state: 'failed', message: 'x', status: 413, body: '{}' });
});

test('moving from Termux is asked for on the channel, and answering the offer puts it away for good', async () => {
  const sent: string[] = [];
  const listeners = new Set<(event: MessageEvent<string>) => void>();
  (globalThis as { STMApp?: unknown }).STMApp = {
    postMessage(message: string) {
      sent.push(message);
      const asked = (JSON.parse(message) as { type: string }).type;
      const reply = asked === 'features'
        ? JSON.stringify({ type: 'features', importZip: true, termux: true, termuxOffer: true })
        : asked === 'importTermux' ? JSON.stringify({ type: 'import', state: 'canceled' }) : null;
      if (reply) queueMicrotask(() => { for (const listener of [...listeners]) listener({ data: reply } as MessageEvent<string>); });
    },
    addEventListener(_type: 'message', listener: (event: MessageEvent<string>) => void) { listeners.add(listener); },
    removeEventListener(_type: 'message', listener: (event: MessageEvent<string>) => void) { listeners.delete(listener); },
  };
  try {
    assert.deepEqual(await importZipFromApp('token', () => undefined, undefined, 'termux'), { state: 'canceled' });
    assert.deepEqual(await appFeatures(), { importZip: true, termux: true, termuxOffer: true, appUpdate: false });
    answerTermuxOffer(true);
    assert.deepEqual(await appFeatures(), { importZip: true, termux: true, termuxOffer: false, appUpdate: false });
    assert.deepEqual(sent.map((message) => JSON.parse(message) as unknown), [
      { type: 'importTermux', csrf: 'token' },
      { type: 'features' },
      { type: 'termuxOffer', dismiss: true },
    ]);
  } finally {
    delete (globalThis as { STMApp?: unknown }).STMApp;
  }
});

test('the app says it installs its own updates, and how one goes', () => {
  assert.deepEqual(parseFeatures('{"type":"features","importZip":true,"appUpdate":true}'), { importZip: true, termux: false, termuxOffer: false, appUpdate: true });
  assert.deepEqual(parseAppUpdateEvent('{"type":"appUpdate","state":"progress","received":5,"total":10}'), { state: 'progress', received: 5, total: 10 });
  assert.deepEqual(parseAppUpdateEvent('{"type":"appUpdate","state":"progress"}'), { state: 'progress', received: 0, total: -1 });
  assert.deepEqual(parseAppUpdateEvent('{"type":"appUpdate","state":"failed","code":"checksum"}'), { state: 'failed', code: 'checksum' });
  assert.deepEqual(parseAppUpdateEvent('{"type":"appUpdate","state":"installing"}'), { state: 'installing' });
  for (const data of ['{"type":"import","state":"progress"}', '{"type":"appUpdate","state":"what"}', 'not json', null]) {
    assert.equal(parseAppUpdateEvent(data), null, String(data));
  }
});

test('an update is asked for on the channel; progress goes to the caller and the end resolves it', async () => {
  const sent: string[] = [];
  const listeners = new Set<(event: MessageEvent<string>) => void>();
  const say = (message: object) => { for (const listener of [...listeners]) listener({ data: JSON.stringify(message) } as MessageEvent<string>); };
  (globalThis as { STMApp?: unknown }).STMApp = {
    postMessage(message: string) {
      sent.push(message);
      if ((JSON.parse(message) as { type: string }).type !== 'appUpdate') return;
      queueMicrotask(() => {
        say({ type: 'appUpdate', state: 'progress', received: 1, total: 2 });
        say({ type: 'appUpdate', state: 'permission' });
        say({ type: 'appUpdate', state: 'installing' });
      });
    },
    addEventListener(_type: 'message', listener: (event: MessageEvent<string>) => void) { listeners.add(listener); },
    removeEventListener(_type: 'message', listener: (event: MessageEvent<string>) => void) { listeners.delete(listener); },
  };
  try {
    const seen: unknown[] = [];
    const controller = new AbortController();
    assert.deepEqual(await updateApp('9.9.9', (event) => seen.push(event), controller.signal), { state: 'installing' });
    assert.deepEqual(seen, [{ state: 'progress', received: 1, total: 2 }, { state: 'permission' }]);
    assert.equal(listeners.size, 0);
    // Over: aborting now asks the app for nothing.
    controller.abort();
    assert.deepEqual(sent.map((message) => JSON.parse(message) as unknown), [{ type: 'appUpdate', version: '9.9.9' }]);
  } finally {
    delete (globalThis as { STMApp?: unknown }).STMApp;
  }
});

test('a browser has no app to update', async () => {
  assert.equal(await updateApp('9.9.9', () => undefined), null);
});
