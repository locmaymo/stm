import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHostname, isThisMachine, readAddressOfferAnswered, readOwnLinkWanted, saveAddressOfferAnswered, saveOwnLinkWanted, shouldOfferPlatformAddress } from '../src/hosting.js';

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

test('the platform address is offered once, in a frame, and never on the reader’s own machine', () => {
  const hosted = 'some-app-123456789012.example-region.hosted.example';
  assert.equal(shouldOfferPlatformAddress({ hostname: hosted, framed: true, answered: false }), true);
  // Already in a tab of its own, it is already at that address.
  assert.equal(shouldOfferPlatformAddress({ hostname: hosted, framed: false, answered: false }), false);
  // A phone running this for itself, or a device in the house, is never asked.
  assert.equal(shouldOfferPlatformAddress({ hostname: '127.0.0.1', framed: true, answered: false }), false);
  assert.equal(shouldOfferPlatformAddress({ hostname: '192.168.1.20', framed: true, answered: false }), false);
  assert.equal(shouldOfferPlatformAddress({ hostname: hosted, framed: true, answered: true }), false);
});

test('the answer and a link asked for before setup are remembered, and storage that refuses is not fatal', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  assert.equal(readAddressOfferAnswered(storage), false);
  saveAddressOfferAnswered(storage);
  assert.equal(readAddressOfferAnswered(storage), true);
  assert.equal(readOwnLinkWanted(storage), false);
  saveOwnLinkWanted(storage, true);
  assert.equal(readOwnLinkWanted(storage), true);
  saveOwnLinkWanted(storage, false);
  assert.equal(readOwnLinkWanted(storage), false);

  // A private window, or a browser with site data blocked, throws on both.
  const blocked = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(readAddressOfferAnswered(blocked), false);
  assert.doesNotThrow(() => saveAddressOfferAnswered(blocked));
  assert.doesNotThrow(() => saveOwnLinkWanted(blocked, true));
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
