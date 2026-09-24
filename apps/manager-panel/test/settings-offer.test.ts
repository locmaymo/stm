import test from 'node:test';
import assert from 'node:assert/strict';
import type { ManagerSettingsOffer } from '../../../packages/contracts/src/index.js';
import { readDismissedRecovery, readDismissedSettings, saveDismissedRecovery, saveDismissedSettings, shouldOfferSettings, shouldShowRecovery } from '../src/settings-offer.js';

const WRITTEN_AT = '2026-09-20T09:02:19.000Z';

const OFFER: ManagerSettingsOffer = {
  available: true,
  label: 'laptop',
  writtenAt: WRITTEN_AT,
  mine: false,
  hasAdminPassword: true,
  hasAccessPassword: true,
};

function storage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test('settings another machine left are offered until they are waved away', () => {
  assert.equal(shouldOfferSettings(OFFER, null), true);
  assert.equal(shouldOfferSettings(OFFER, WRITTEN_AT), false);
});

test('settings this installation wrote itself are never offered back to it', () => {
  // The case that made this worth fixing: a machine opened with a Cloudflare
  // account writes its settings to the bucket and, minutes later, is told
  // another machine has settings there - naming itself.
  assert.equal(shouldOfferSettings({ ...OFFER, mine: true }, null), false);
  assert.equal(shouldOfferSettings({ ...OFFER, available: false }, null), false);
  assert.equal(shouldOfferSettings(null, null), false);
});

test('a machine that writes newer settings is offered again', () => {
  // Dismissing is a decision about those settings, not about ever being told.
  const newer = { ...OFFER, writtenAt: '2026-09-21T10:00:00.000Z' };
  assert.equal(shouldOfferSettings(newer, WRITTEN_AT), true);
});

test('the dismissal survives a reload, and a browser without storage is fine', () => {
  const store = storage();
  assert.equal(readDismissedSettings(store), null);
  saveDismissedSettings(WRITTEN_AT, store);
  assert.equal(readDismissedSettings(store), WRITTEN_AT);

  assert.equal(readDismissedSettings(undefined), null);
  assert.doesNotThrow(() => saveDismissedSettings(WRITTEN_AT, undefined));
});

const RECOVERED_AT = '2026-09-20T16:08:19.528Z';

test('the recovery notice is shown once and can be put down', () => {
  // News about something that already finished: worth saying, not worth
  // saying for the life of the installation.
  assert.equal(shouldShowRecovery(RECOVERED_AT, null), true);
  assert.equal(shouldShowRecovery(RECOVERED_AT, RECOVERED_AT), false);
  assert.equal(shouldShowRecovery(null, null), false);
  // A later recovery is different news, so it is said again.
  assert.equal(shouldShowRecovery('2026-09-21T08:00:00.000Z', RECOVERED_AT), true);
});

test('the recovery dismissal is remembered separately from the settings one', () => {
  const store = storage();
  saveDismissedSettings(WRITTEN_AT, store);
  assert.equal(readDismissedRecovery(store), null, 'waving away settings does not hide a recovery');
  saveDismissedRecovery(RECOVERED_AT, store);
  assert.equal(readDismissedRecovery(store), RECOVERED_AT);
  assert.equal(readDismissedSettings(store), WRITTEN_AT);

  assert.equal(readDismissedRecovery(undefined), null);
  assert.doesNotThrow(() => saveDismissedRecovery(RECOVERED_AT, undefined));
});
