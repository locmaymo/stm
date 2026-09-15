import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from 'qrcode-generator';
import { bootstrapBanner, codeWidth, qrCodeLines } from '../src/banner.js';

const ESCAPE = '\u001b';
const QUIET_ZONE = 4;

const base = {
  title: 'ST Manager 0.1.0',
  addresses: [
    { label: 'On this computer', url: 'http://127.0.0.1:7860' },
    { label: 'On this Wi-Fi', url: 'http://192.168.1.25:7860' },
  ],
  stopHint: 'Press Ctrl+C to stop.',
} as const;

test('piped into a file, the banner is text and nothing else', () => {
  const banner = bootstrapBanner({ ...base, qr: { value: 'http://192.168.1.25:7860', caption: 'Scan' }, colour: false });
  // A service manager's journal and a redirected log get no escapes, no block
  // characters, and no code drawn out of characters that mean nothing there.
  assert.equal(banner.includes(ESCAPE), false);
  assert.equal(banner.includes('▀'), false);
  assert.equal(banner.includes('Scan'), false);
  assert.ok(banner.includes('http://127.0.0.1:7860'));
  assert.ok(banner.includes('http://192.168.1.25:7860'));
  assert.ok(banner.includes('Press Ctrl+C to stop.'));
});

test('the addresses line up under one another', () => {
  const banner = bootstrapBanner({ ...base, colour: false });
  const columns = banner.split('\n')
    .filter((line) => line.includes('http://'))
    .map((line) => line.indexOf('http://'));
  assert.equal(new Set(columns).size, 1, `addresses start at ${columns.join(' and ')}`);
});

test('a narrow window gets the addresses rather than a wrapped code', () => {
  const banner = bootstrapBanner({
    ...base,
    qr: { value: 'http://192.168.1.25:7860', caption: 'Scan' },
    colour: true,
    width: 20,
  });
  // Half a code is worse than no code: it cannot be scanned and it hides the
  // address that could have been typed instead.
  assert.equal(banner.includes('▀'), false);
  assert.ok(banner.includes('http://192.168.1.25:7860'));
});

test('what is drawn is the code the library produced', () => {
  const value = 'http://192.168.1.25:7860';
  const lines = qrCodeLines(value);
  const expected = qrcode(0, 'M');
  expected.addData(value);
  expected.make();
  const modules = expected.getModuleCount();
  const span = modules + QUIET_ZONE * 2;
  assert.equal(codeWidth(lines), span);
  assert.equal(lines.length, Math.ceil(span / 2));

  // Read the drawing back: the upper half block carries the foreground colour
  // for its own row and the background colour for the row below it, so black
  // ink is a dark module either way.
  const drawn = (row: number, column: number): boolean => {
    const line = lines[Math.floor(row / 2)] ?? '';
    let foreground = 37;
    let background = 47;
    let cell = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === ESCAPE) {
        const end = line.indexOf('m', index);
        const codes = line.slice(index + 2, end).split(';').map(Number);
        foreground = codes[0] ?? foreground;
        background = codes[1] ?? background;
        index = end;
        continue;
      }
      if (cell === column) return row % 2 === 0 ? foreground === 30 : background === 40;
      cell += 1;
    }
    return false;
  };

  for (let row = 0; row < span; row += 1) {
    for (let column = 0; column < span; column += 1) {
      const inside = row >= QUIET_ZONE && row < QUIET_ZONE + modules && column >= QUIET_ZONE && column < QUIET_ZONE + modules;
      const wanted = inside && expected.isDark(row - QUIET_ZONE, column - QUIET_ZONE);
      assert.equal(drawn(row, column), wanted, `module ${row},${column}`);
    }
  }
});

test('the quiet zone is there, because a scanner needs it to find the code', () => {
  const lines = qrCodeLines('http://127.0.0.1:7860');
  const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ''));
  const span = codeWidth(lines);
  // Four module rows of margin is two text rows, top and bottom.
  assert.equal(plain[0]?.trim().length, span, 'the top rows are drawn, in white');
  assert.equal(plain[1], plain[0], 'and the second row matches the first');
});
