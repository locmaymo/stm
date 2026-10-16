import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { StateStore } from '../src/state.js';
import { hashPassword, verifyPassword } from '../src/password.js';

test('state survives a restart and keeps the identity it was created with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-state-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths });
  const created = await first.load();

  const second = new StateStore({ paths });
  const reloaded = await second.load();
  assert.equal(reloaded.installId, created.installId);
  assert.equal(reloaded.createdAt, created.createdAt);
  assert.equal(reloaded.adminPasswordHash, null);
});

test('manager password changes persist across a new state store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-state-password-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths });
  await first.load();
  const original = hashPassword('123456');
  assert.equal(await first.saveAdminPassword(original), true);
  const changed = hashPassword('654321');
  assert.equal(await first.changeAdminPassword(changed), true);

  const second = new StateStore({ paths });
  const state = await second.load();
  assert.ok(state.adminPasswordHash);
  assert.equal(verifyPassword('654321', state.adminPasswordHash), true);
  assert.equal(verifyPassword('123456', state.adminPasswordHash), false);
});

test('a Google account claims only a manager nobody has set up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-state-google-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });

  // A blank manager: the machine coming back after a wipe. The first account is its owner.
  const blank = new StateStore({ paths });
  await blank.load();
  assert.deepEqual(await blank.claimGoogleOwner('perm-owner', 'owner@example.com'), { allowed: true, owner: 'owner@example.com' });
  assert.deepEqual(await blank.claimGoogleOwner('perm-owner', 'owner@example.com'), { allowed: true, owner: 'owner@example.com' });
  assert.deepEqual(await blank.claimGoogleOwner('perm-stranger', 'stranger@example.com'), { allowed: false, owner: 'owner@example.com' });
  assert.deepEqual(await new StateStore({ paths }).googleOwner(), { id: 'perm-owner', email: 'owner@example.com' });

  // A manager with a password is not taken by whoever signs in first.
  const otherRoot = await mkdtemp(join(tmpdir(), 'stm-state-google-pw-'));
  const protectedPaths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: otherRoot } });
  const configured = new StateStore({ paths: protectedPaths });
  await configured.load();
  assert.equal(await configured.saveAdminPassword(hashPassword('123456')), true);
  assert.deepEqual(await configured.claimGoogleOwner('perm-stranger', 'stranger@example.com'), { allowed: false, owner: null });
  assert.equal(await configured.googleOwner(), null);

  // Its owner connects Google Drive from the console; that account may open it from then on.
  await configured.recordGoogleOwner('perm-owner', 'owner@example.com');
  assert.equal((await configured.claimGoogleOwner('perm-owner', 'owner@example.com')).allowed, true);
  assert.equal((await configured.claimGoogleOwner('perm-stranger', 'stranger@example.com')).allowed, false);
  await configured.releaseGoogleOwner();
  assert.equal((await configured.claimGoogleOwner('perm-owner', 'owner@example.com')).allowed, false);
});
