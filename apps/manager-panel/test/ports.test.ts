import test from 'node:test';
import assert from 'node:assert/strict';
import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import { HIGHEST_PORT, LOWEST_PORT, portRefusal } from '../src/ports.js';

const RESERVED = { manager: 7860, access: 8001 };

test('a port the manager already answers on is refused before it is sent', () => {
  assert.equal(portRefusal('8000', RESERVED), null);
  assert.equal(portRefusal(' 8123 ', RESERVED), null, 'a number typed with spaces is still that number');
  assert.equal(portRefusal(String(LOWEST_PORT), RESERVED), null);
  assert.equal(portRefusal(String(HIGHEST_PORT), RESERVED), null);

  assert.deepEqual(portRefusal('7860', RESERVED), { key: 'console.portTakenByManager', params: { port: 7860 } });
  assert.deepEqual(portRefusal('8001', RESERVED), { key: 'console.portTakenByAccess', params: { port: 8001 } });
  // Which port is refused follows wherever STM_PORT put the console.
  assert.equal(portRefusal('7860', { manager: 9000, access: 8001 }), null);
  assert.deepEqual(portRefusal('9000', { manager: 9000, access: 8001 }), { key: 'console.portTakenByManager', params: { port: 9000 } });
});

test('anything that is not a plain port number is refused as out of range', () => {
  // '12e3', '0x1f' and '8000.0' are numbers to Number() and not to a port
  // field, which is why the check reads digits rather than parsing.
  for (const typed of ['', ' ', '80', '1023', '65536', '0', '-1', '8000.0', '12e3', '0x1f', 'eight thousand']) {
    assert.deepEqual(
      portRefusal(typed, RESERVED),
      { key: 'console.portInvalid', params: { lowest: LOWEST_PORT, highest: HIGHEST_PORT } },
      `${JSON.stringify(typed)} should be refused`,
    );
  }
});

test('every refusal names a message the panel actually ships', () => {
  const refusals = [portRefusal('80', RESERVED), portRefusal('7860', RESERVED), portRefusal('8001', RESERVED)];
  for (const refusal of refusals) {
    assert.ok(refusal, 'these are all refusals');
    const key = refusal.key.slice('console.'.length) as keyof typeof en.console;
    assert.equal(typeof en.console[key], 'string', `${refusal.key} is missing from the catalogue`);
    // Every placeholder the message carries has to be one the refusal supplies,
    // or the reader is shown a literal {port}.
    for (const [, name] of (en.console[key] as string).matchAll(/\{(\w+)\}/gu)) {
      assert.ok(name !== undefined && name in refusal.params, `${refusal.key} does not supply {${String(name)}}`);
    }
  }
});
