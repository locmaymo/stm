import test from 'node:test';
import assert from 'node:assert/strict';
import { machineName, publicAddress, publicLinks, reachableAddresses, shortenHost } from '../src/addresses.js';

test('the tunnel comes first, then the network, then this machine', () => {
  const all = reachableAddresses({ url: 'https://example.trycloudflare.com' }, { lan: true, port: 8001 }, '192.168.1.20', 8000, true);
  assert.deepEqual(all.map((address) => address.kind), ['tunnel', 'lan', 'local']);
  assert.equal(all[0]?.host, 'example.trycloudflare.com');
  assert.equal(all[1]?.url, 'http://192.168.1.20:8001');
});

test('with nothing shared, this machine is the only address', () => {
  const only = reachableAddresses({ url: null }, { lan: false, port: 8001 }, 'localhost', 8000, true);
  assert.deepEqual(only.map((address) => address.url), ['http://127.0.0.1:8000']);
});

test('moving SillyTavern moves the address that points straight at it', () => {
  // The loopback link used to carry 8000 whatever the console had been told,
  // so every address on the overview pointed at a port SillyTavern had left.
  const moved = reachableAddresses({ url: null }, { lan: false, port: 8001 }, 'localhost', 8003, true);
  assert.deepEqual(moved.map((address) => address.url), ['http://127.0.0.1:8003']);
  assert.equal(moved[0]?.host, '127.0.0.1:8003');
  // The gateway keeps its own port: it is the door, not what is behind it.
  const shared = reachableAddresses({ url: null }, { lan: true, port: 8001 }, '192.168.1.20', 8003, true);
  assert.deepEqual(shared.map((address) => address.url), ['http://192.168.1.20:8001', 'http://127.0.0.1:8003']);
});

test('a fixed address in front of the tunnel is the one offered', () => {
  /*
   * A Quick Tunnel's hostname changes every time cloudflared starts, so it is
   * the wrong thing to hand anybody: the link they save or send stops working
   * on the next restart, and stops as DNS_PROBE_FINISHED_NXDOMAIN because the
   * name has gone from DNS altogether. The Worker address is the same one for
   * good, so it is what the card shows and what the Open button takes.
   */
  const withProxy = reachableAddresses(
    { url: 'https://example.trycloudflare.com', proxyUrl: 'https://sillytavern.acme.workers.dev' },
    { lan: false, port: 8001 },
    'localhost',
    8000,
    false,
  );
  // First, and the tunnel's own after it: still an address that works, and
  // the card offers it behind a "+1".
  assert.deepEqual(withProxy.map((address) => address.url), ['https://sillytavern.acme.workers.dev', 'https://example.trycloudflare.com']);
  assert.deepEqual(withProxy.map((address) => address.link), ['fixed', 'tunnel']);
  // The tunnel behind it is still worth being able to see: it is what the
  // traffic really goes through, and the share sheet says so.
  assert.equal(withProxy[0]?.via, 'example.trycloudflare.com');

  // With no Cloudflare sign-in there is no Worker, and the tunnel's own
  // address is the only address there is.
  const withoutProxy = reachableAddresses({ url: 'https://example.trycloudflare.com', proxyUrl: null }, { lan: false, port: 8001 }, 'localhost', 8000, false);
  assert.deepEqual(withoutProxy.map((address) => address.url), ['https://example.trycloudflare.com']);
  assert.equal(withoutProxy[0]?.via, undefined);

  // A Worker deployed while the tunnel is off is still the address to show:
  // it answers, and it says the door is shut.
  const tunnelOff = reachableAddresses({ url: null, proxyUrl: 'https://stm.acme.workers.dev' }, { lan: false, port: 8001 }, 'localhost', 8000, false);
  assert.deepEqual(tunnelOff.map((address) => address.url), ['https://stm.acme.workers.dev']);
  assert.equal(tunnelOff[0]?.via, undefined);
});

test('an address still being deployed is not an address anybody is given', () => {
  /*
   * Deploying the Worker takes seconds, and the tunnel announces its own
   * address long before that finishes. The console used to show that address
   * and then swap it for the permanent one - so what somebody had already
   * copied was the address about to be thrown away. On every run after the
   * first it was worse: the Worker exists, still pointing at last time's
   * tunnel, so the link on the card answered with an error.
   */
  assert.equal(publicAddress({ url: 'https://new.trycloudflare.com', proxyUrl: null, proxyPending: true }), null);
  assert.equal(publicAddress({ url: 'https://new.trycloudflare.com', proxyUrl: 'https://stm.acme.workers.dev', proxyPending: true }), null);
  // Once it points at the tunnel that is up, it is the address to give.
  assert.equal(publicAddress({ url: 'https://new.trycloudflare.com', proxyUrl: 'https://stm.acme.workers.dev', proxyPending: false }), 'https://stm.acme.workers.dev');
  // And with no Cloudflare sign-in nothing is ever pending, so the tunnel's
  // own address is offered the moment it exists.
  assert.equal(publicAddress({ url: 'https://new.trycloudflare.com', proxyUrl: null, proxyPending: false }), 'https://new.trycloudflare.com');

  // The card loses the public row while it waits rather than showing one that
  // is about to change; the addresses that do work are still there.
  const waiting = reachableAddresses(
    { url: 'https://new.trycloudflare.com', proxyUrl: 'https://stm.acme.workers.dev', proxyPending: true },
    { lan: true, port: 8001 },
    '192.168.1.20',
    8000,
    false,
  );
  assert.deepEqual(waiting.map((address) => address.kind), ['lan']);
});

test('a long host keeps its two ends and a short one is left alone', () => {
  assert.equal(shortenHost('example.trycloudflare.com'), 'examp...flare.com');
  // A short kind of address keeps its last two labels whole.
  assert.equal(shortenHost('sillytavern.acme.workers.dev'), 'silly...workers.dev');
  assert.equal(shortenHost('127.0.0.1:8000'), '127.0.0.1:8000');
  assert.equal(shortenHost('192.168.100.200:8001'), '192.168.100.200:8001');
});

test('read from anywhere but the machine itself, the loopback address is not offered', () => {
  // A hosted console is a page served from a container in a data centre. The
  // loopback address there names the reader's own laptop, so offering it as
  // the way in is a link that can only ever fail - and it used to be the one
  // the Open button took.
  const hosted = reachableAddresses({ url: null }, { lan: false, port: 8001 }, '10.0.0.4', 8000, false);
  assert.deepEqual(hosted, []);
  // What is published still counts, and is still in the same order.
  const published = reachableAddresses({ url: 'https://example.trycloudflare.com' }, { lan: true, port: 8001 }, '10.0.0.4', 8000, false);
  assert.deepEqual(published.map((address) => address.kind), ['tunnel', 'lan']);
});

test('a machine with no network of its own offers no address on one', () => {
  // A hosted container has no Wi-Fi to be on, so `networkHost` is null. The
  // address used to fall back to the hostname in the reader's browser, which
  // is where the reader is and says nothing about where this machine answers:
  // on a hosted studio it produced `some-app.hosted.example:8001`, shown under "on
  // this Wi-Fi" though the platform serves no such port and the phone being
  // invited is on another network entirely.
  const hosted = reachableAddresses({ url: null }, { lan: true, port: 8001 }, null, 8000, false);
  assert.deepEqual(hosted, []);
  // Sharing being switched on does not conjure one, and the addresses that do
  // work are untouched.
  const published = reachableAddresses({ url: 'https://example.trycloudflare.com' }, { lan: true, port: 8001 }, null, 8000, true);
  assert.deepEqual(published.map((address) => address.kind), ['tunnel', 'local']);
  // A machine that does have one still gets it.
  const athome = reachableAddresses({ url: null }, { lan: true, port: 8001 }, '192.168.1.20', 8000, true);
  assert.deepEqual(athome.map((address) => address.host), ['192.168.1.20:8001', '127.0.0.1:8000']);
});

test('another machine is named by its hostname, or by both ends of its address', () => {
  assert.equal(machineName('laptop'), 'laptop');
  assert.equal(machineName('studio-123456789012.hosted.example'), 'studio-12345...sted.example');
  assert.equal(machineName('studio.hosted.example'), 'studio.hosted.example');
});

test('the address the reader starred goes first, and a hidden fixed address is not offered', () => {
  const both = { url: 'https://example.trycloudflare.com', proxyUrl: 'https://sillytavern.acme.workers.dev' };
  assert.deepEqual(publicLinks(both).map((link) => link.kind), ['fixed', 'tunnel'], 'the fixed one first, as always, when nothing was chosen');
  assert.deepEqual(publicLinks({ ...both, linkPreference: { preferred: 'tunnel', showFixed: true } }).map((link) => link.kind), ['tunnel', 'fixed']);
  assert.equal(publicAddress({ ...both, linkPreference: { preferred: 'tunnel', showFixed: true } }), 'https://example.trycloudflare.com');
  assert.deepEqual(publicLinks({ ...both, linkPreference: { preferred: 'fixed', showFixed: false } }).map((link) => link.kind), ['tunnel']);
  // Preferring the tunnel's own address is not kept waiting for a Worker
  // deploy nobody is going to use.
  assert.equal(publicAddress({ ...both, proxyPending: true, linkPreference: { preferred: 'tunnel', showFixed: true } }), 'https://example.trycloudflare.com');
  assert.equal(publicAddress({ ...both, proxyPending: true }), null);
});
