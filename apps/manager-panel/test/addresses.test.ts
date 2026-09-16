import test from 'node:test';
import assert from 'node:assert/strict';
import { reachableAddresses, shortenHost } from '../src/addresses.js';

test('the tunnel comes first, then the network, then this machine', () => {
  const all = reachableAddresses({ url: 'https://example.trycloudflare.com' }, { lan: true, port: 8001 }, '192.168.1.20');
  assert.deepEqual(all.map((address) => address.kind), ['tunnel', 'lan', 'local']);
  assert.equal(all[0]?.host, 'example.trycloudflare.com');
  assert.equal(all[1]?.url, 'http://192.168.1.20:8001');
});

test('with nothing shared, this machine is the only address', () => {
  const only = reachableAddresses({ url: null }, { lan: false, port: 8001 }, 'localhost');
  assert.deepEqual(only.map((address) => address.url), ['http://127.0.0.1:8000']);
});

test('a long host keeps its two ends and a short one is left alone', () => {
  assert.equal(shortenHost('example.trycloudflare.com'), 'exam...flare.com');
  assert.equal(shortenHost('127.0.0.1:8000'), '127.0.0.1:8000');
  assert.equal(shortenHost('192.168.100.200:8001'), '192.168.100.200:8001');
});
