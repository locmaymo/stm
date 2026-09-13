import assert from 'node:assert/strict';
import test from 'node:test';
import { qrCodePath } from '../src/qr-code.js';

test('a tunnel address becomes a scannable code with its quiet zone', () => {
  const { span, path } = qrCodePath('https://mixed-words-here-example.trycloudflare.com');
  // Version 4 holds this much byte-mode text at error correction M: 33 modules
  // plus the four-module quiet zone the format requires on each side.
  assert.equal(span, 33 + 8);
  // Each finder pattern is a 7x7 block, and the top-left one starts at the
  // first module inside the quiet zone.
  assert.ok(path.includes('M4 4h1v1h-1z'), 'the top-left finder pattern starts inside the quiet zone');
  assert.ok(path.length > 1000, 'a real code has hundreds of dark modules');
});

test('a longer address needs a larger code rather than failing', () => {
  const short = qrCodePath('http://192.168.1.20:8000');
  const long = qrCodePath(`http://192.168.1.20:8000/?token=${'a'.repeat(200)}`);
  assert.ok(long.span > short.span);
});
