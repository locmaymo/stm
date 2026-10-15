import test from 'node:test';
import assert from 'node:assert/strict';
import { maskProxy, proxySchemeOf, readProxy, savedProxy } from '../src/proxy-address.js';

const url = (input: string, scheme?: string): string | null => {
  const reading = readProxy(input, scheme);
  return reading.ok ? reading.url : null;
};

test('every way a seller prints a proxy becomes the URL SillyTavern reads', () => {
  const wanted = 'http://user:pass@1.2.3.4:8080';
  assert.equal(url('1.2.3.4:8080:user:pass'), wanted);
  assert.equal(url('user:pass@1.2.3.4:8080'), wanted);
  assert.equal(url('1.2.3.4:8080@user:pass'), wanted);
  assert.equal(url('user:pass:1.2.3.4:8080'), wanted);
  assert.equal(url('http://1.2.3.4:8080:user:pass'), wanted);
  assert.equal(url('http://user:pass@1.2.3.4:8080/'), wanted);
  assert.equal(url('  "1.2.3.4:8080:user:pass"  '), wanted, 'quotes and spaces around it from a copy');
  assert.equal(url('1.2.3.4 8080 user pass'), wanted, 'spaces where the colons go');
  assert.equal(url('1.2.3.4:8080 user:pass'), wanted);
});

test('an address with no credentials, or a host name, is kept as it is', () => {
  assert.equal(url('1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(url('Proxy.Example.com:3128'), 'http://proxy.example.com:3128');
  assert.equal(url('localhost:8888'), 'http://localhost:8888');
  assert.equal(url('[2001:db8::1]:1080:user:pass', 'socks5'), 'socks5://user:pass@[2001:db8::1]:1080');
});

test('the kind is the one named in the paste, or the one chosen beside the box', () => {
  assert.equal(url('1.2.3.4:1080:user:pass', 'socks5'), 'socks5://user:pass@1.2.3.4:1080');
  assert.equal(url('socks5://1.2.3.4:1080:user:pass', 'http'), 'socks5://user:pass@1.2.3.4:1080');
  assert.equal(url('SOCKS5H://user:pass@1.2.3.4:1080'), 'socks5h://user:pass@1.2.3.4:1080');
  assert.equal(url('pac+https://proxy.example/proxy.pac'), 'pac+https://proxy.example/proxy.pac');
  assert.deepEqual(readProxy('ftp://1.2.3.4:21'), { ok: false, problem: 'scheme' });
});

test('a password with awkward characters survives, and is not encoded twice', () => {
  assert.equal(url('1.2.3.4:8080:user:p@ss:word'), 'http://user:p%40ss%3Aword@1.2.3.4:8080');
  assert.equal(url('user:p@ss@1.2.3.4:8080'), 'http://user:p%40ss@1.2.3.4:8080');
  assert.equal(url('http://user:p%40ss@1.2.3.4:8080'), 'http://user:p%40ss@1.2.3.4:8080');
  assert.equal(url('1.2.3.4:8080:user'), 'http://user@1.2.3.4:8080', 'a user with no password');
});

test('what cannot be a proxy says which half is wrong', () => {
  assert.deepEqual(readProxy('1.2.3.4'), { ok: false, problem: 'port' });
  assert.deepEqual(readProxy('1.2.3.4:99999'), { ok: false, problem: 'port' });
  assert.deepEqual(readProxy('not a host!:8080'), { ok: false, problem: 'host' });
  assert.deepEqual(readProxy('user:pass@nowhere'), { ok: false, problem: 'port' });
});

test('the password is hidden when shown, and the shipped example is no proxy', () => {
  assert.equal(maskProxy('http://user:secret@1.2.3.4:8080'), 'http://user:•••@1.2.3.4:8080');
  assert.equal(maskProxy('http://1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(proxySchemeOf('socks5://1.2.3.4:1080'), 'socks5');
  assert.equal(proxySchemeOf('socks5h://1.2.3.4:1080'), null);
  assert.equal(savedProxy('socks5://username:password@example.com:1080'), '');
  assert.equal(savedProxy('http://1.2.3.4:8080'), 'http://1.2.3.4:8080');
});
