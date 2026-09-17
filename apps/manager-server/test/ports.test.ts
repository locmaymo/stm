import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { checkSillyTavernPort, findFreePort, isPortFree, PortError, portFromEnvironment, resolveAccessPort, resolveConsolePort, ACCESS_GATEWAY_PORT, MANAGER_PORT, SILLYTAVERN_PORT, type ReservedPorts } from '../src/ports.js';

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

test('a host that publishes one port names it in PORT, and that port is not ours to move', () => {
  // Nothing set: this project's own number, and free to move if it is taken.
  assert.deepEqual(resolveConsolePort({}), { port: MANAGER_PORT, source: 'default' });
  // A container host sets PORT to the one port it routes. Listening anywhere
  // else there is listening where nobody can knock.
  assert.deepEqual(resolveConsolePort({ PORT: '3000' }), { port: 3000, source: 'demanded' });
  // Written down by hand still wins over the platform's.
  assert.deepEqual(resolveConsolePort({ PORT: '3000', STM_PORT: '9000' }), { port: 9000, source: 'demanded' });
  // Nothing readable is nothing routed, so the default stands and may move.
  for (const unusable of ['', ' ', 'auto', '80', '70000', '7860.5']) {
    assert.deepEqual(resolveConsolePort({ PORT: unusable }), { port: MANAGER_PORT, source: 'default' }, `PORT=${unusable} should be ignored`);
  }
  assert.deepEqual(resolveAccessPort({}), { port: ACCESS_GATEWAY_PORT, source: 'default' });
  assert.deepEqual(resolveAccessPort({ STM_ACCESS_PORT: '9001' }), { port: 9001, source: 'demanded' });
});

test('a taken port is stepped over, not fought for', async () => {
  const held = new Set([8000, 8001, 8002]);
  const isFree = (port: number): Promise<boolean> => Promise.resolve(!held.has(port));
  assert.equal(await findFreePort(8000, { reserved: [], host: '127.0.0.1', isFree }), 8003);
  // A port this manager has already spoken for is never the answer, even when
  // nothing is listening on it yet.
  assert.equal(await findFreePort(8000, { reserved: [8003], host: '127.0.0.1', isFree }), 8004);
  assert.equal(await findFreePort(8004, { reserved: [], host: '127.0.0.1', isFree }), 8004);
  // A machine with nothing free nearby is one no amount of trying improves.
  assert.equal(await findFreePort(8000, { reserved: [], host: '127.0.0.1', attempts: 2, isFree }), null);
});

test('a port is free when it can be bound, and held when something already holds it', async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => { taken.listen(0, '127.0.0.1', resolve); });
  const address = taken.address();
  assert.ok(address && typeof address !== 'string');
  try {
    assert.equal(await isPortFree(address.port, '127.0.0.1'), false);
  } finally {
    await new Promise<void>((resolve) => { taken.close(() => { resolve(); }); });
  }
  // And free again once it is let go, which is what makes the probe usable
  // rather than a one-way door.
  assert.equal(await isPortFree(address.port, '127.0.0.1'), true);
});
