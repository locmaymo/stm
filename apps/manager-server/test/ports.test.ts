import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSillyTavernPort, PortError, portFromEnvironment, ACCESS_GATEWAY_PORT, MANAGER_PORT, SILLYTAVERN_PORT, type ReservedPorts } from '../src/ports.js';

const RESERVED: ReservedPorts = { manager: MANAGER_PORT, access: ACCESS_GATEWAY_PORT };

/** The refusal a port earned, so the test can read why rather than only that. */
function refusal(port: unknown, reserved: ReservedPorts = RESERVED): PortError {
  try {
    checkSillyTavernPort(port, reserved);
  } catch (error: unknown) {
    assert.ok(error instanceof PortError, 'a port is refused with a PortError');
    return error;
  }
  throw new assert.AssertionError({ message: `port ${String(port)} was accepted` });
}

test('SillyTavern may take any free port, but not one the manager already answers on', () => {
  assert.equal(checkSillyTavernPort(SILLYTAVERN_PORT, RESERVED), SILLYTAVERN_PORT);
  assert.equal(checkSillyTavernPort(8123, RESERVED), 8123);
  assert.equal(checkSillyTavernPort(65535, RESERVED), 65535);

  // The two the manager holds, each refused by name so the panel can say which.
  assert.equal(refusal(MANAGER_PORT).code, 'port_conflict');
  assert.equal(refusal(MANAGER_PORT).holder, 'manager');
  assert.equal(refusal(ACCESS_GATEWAY_PORT).code, 'port_conflict');
  assert.equal(refusal(ACCESS_GATEWAY_PORT).holder, 'access');

  // Moving the manager with STM_PORT moves which port is refused with it.
  const moved: ReservedPorts = { manager: 9000, access: ACCESS_GATEWAY_PORT };
  assert.equal(checkSillyTavernPort(MANAGER_PORT, moved), MANAGER_PORT);
  assert.equal(refusal(9000, moved).holder, 'manager');
});

test('a port that could not be taken is refused where it was typed, not where it would fail', () => {
  for (const bad of [80, 1023, 0, -1, 65536, 8000.5, '8000', null, undefined]) {
    assert.equal(refusal(bad).code, 'port_invalid', `${String(bad)} should be refused as invalid`);
  }
});

test('an unreadable port in the environment falls back instead of keeping the console down', () => {
  assert.equal(portFromEnvironment('9000', MANAGER_PORT), 9000);
  assert.equal(portFromEnvironment(' 9000 ', MANAGER_PORT), 9000);
  for (const unusable of [undefined, '', 'seven thousand', '80', '70000', '7860.5']) {
    assert.equal(portFromEnvironment(unusable, MANAGER_PORT), MANAGER_PORT, `${String(unusable)} should fall back`);
  }
});
