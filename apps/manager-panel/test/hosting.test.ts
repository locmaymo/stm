import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCESS_LINKS, type OwnLinkState } from '../../../packages/contracts/src/index.js';
import { isLocalHostname, isThisMachine, mustLeaveFrame, ownLinkView } from '../src/hosting.js';

test('an address the reader already has is not one they need a tunnel for', () => {
  for (const hostname of [
    '127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', 'stm.localhost', '::1', '[::1]', '0.0.0.0',
    'raspberrypi.local', '192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.254',
    '100.101.102.103', 'fd7a:115c:a1e0::1', 'fe80::1',
  ]) {
    assert.equal(isLocalHostname(hostname), true, hostname);
  }
});

test('a hosted address is one the platform gave out, and may not work tomorrow', () => {
  for (const hostname of [
    'fluffy-doodle-jqx4w64pw5vhpv5g-7860.app.github.dev',
    // A workspace preview: one long name a platform issued, on a domain that
    // is the platform's rather than anybody's.
    'a1b2c3d4e5f6g7h8-123456789012.example-region.hosted.example',
    'tenant-stm.workspaces.example', 'www.some-platform.example', 'busy-lake-1234.trycloudflare.com',
    'stm.example.com', '203.0.113.9',
    // Neighbours of the private ranges, which are ordinary public addresses.
    '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.63.0.1', '100.128.0.1',
  ]) {
    assert.equal(isLocalHostname(hostname), false, hostname);
  }
});

test('a console in a platform’s frame sends the reader away, every time, and never on their own machine', () => {
  const hosted = 'some-app-123456789012.example-region.hosted.example';
  assert.equal(mustLeaveFrame({ hostname: hosted, framed: true }), true);
  // In a tab of its own it is already where it works.
  assert.equal(mustLeaveFrame({ hostname: hosted, framed: false }), false);
  // A frame on this machine or in the house is one somebody built on purpose.
  assert.equal(mustLeaveFrame({ hostname: '127.0.0.1', framed: true }), false);
  assert.equal(mustLeaveFrame({ hostname: '192.168.1.20', framed: true }), false);
});

test('what the frame shows follows what the manager says about its link', () => {
  const base: OwnLinkState = { available: true, opening: false, status: 'stopped', url: null, error: null, proxyUrl: null, proxyPending: false };
  // Asked for, and cloudflared still being fetched: nothing on the tunnel yet.
  assert.deepEqual(ownLinkView({ ...base, opening: true }), { kind: 'opening' });
  assert.deepEqual(ownLinkView({ ...base, status: 'starting' }), { kind: 'opening' });
  assert.deepEqual(ownLinkView({ ...base, status: 'running', url: 'https://busy-lake-1234.trycloudflare.com' }), { kind: 'link', address: 'https://busy-lake-1234.trycloudflare.com' });
  // The console's fixed address goes first where there is one, as it does
  // everywhere else the console's link is shown.
  assert.deepEqual(
    ownLinkView({ ...base, available: false, status: 'running', url: 'https://busy-lake-1234.trycloudflare.com', proxyUrl: 'https://stm.acme.workers.dev', linkPreference: DEFAULT_ACCESS_LINKS.manager }),
    { kind: 'link', address: 'https://stm.acme.workers.dev' },
  );
  // A blank console whose link failed can be asked again.
  assert.deepEqual(ownLinkView({ ...base, status: 'error', error: 'cloudflared could not start' }), { kind: 'failed', error: 'cloudflared could not start' });
  assert.deepEqual(ownLinkView(base), { kind: 'failed', error: null });
  // One with an owner cannot: the link is theirs, and off or broken it leaves
  // the form as the only way in.
  assert.deepEqual(ownLinkView({ ...base, available: false }), { kind: 'stay' });
  assert.deepEqual(ownLinkView({ ...base, available: false, status: 'error', error: 'cloudflared could not start' }), { kind: 'stay' });
});

test('this machine is the loopback addresses, and nothing else', () => {
  // The console is on the machine the reader is sitting at.
  for (const host of ['localhost', 'st.localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]', '0.0.0.0']) {
    assert.equal(isThisMachine(host), true, host);
  }
  // Reached over something. A phone on the same Wi-Fi is not this machine, and
  // the loopback address there is the phone's own.
  for (const host of ['192.168.1.20', '10.0.0.4', 'studio.some-platform.example', 'example.trycloudflare.com', 'macbook.local']) {
    assert.equal(isThisMachine(host), false, host);
  }
});
