import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleOfferWanted, offerAccepted, offerDue, offerSnoozed } from '../src/offers.js';

const DAY = 24 * 60 * 60 * 1000;

test('an offer is made until "Not now", once more a fortnight later, then never', () => {
  const start = Date.UTC(2026, 9, 12);
  assert.equal(offerDue(null, start), true, 'never answered: asked');
  const once = offerSnoozed(null, start);
  assert.equal(offerDue(once, start + 13 * DAY), false);
  assert.equal(offerDue(once, start + 14 * DAY), true, 'asked once more');
  const twice = offerSnoozed(once, start + 14 * DAY);
  assert.equal(offerDue(twice, start + 400 * DAY), false, 'and then left alone');
  assert.equal(offerDue('not json', start), true, 'an answer nobody can read is no answer');
  assert.equal(offerDue(offerAccepted(start), start + 400 * DAY), false, 'said yes once: turning it off later is not a reason to ask again');
});

test('there is something to offer only on a phone that floats bubbles, while they are not on', () => {
  const state = { replies: true, enabled: false, bubbles: true, allowed: true };
  assert.equal(bubbleOfferWanted(null), false, 'no app to ask');
  assert.equal(bubbleOfferWanted(state), true);
  assert.equal(bubbleOfferWanted({ ...state, enabled: true }), false, 'already on');
  assert.equal(bubbleOfferWanted({ ...state, enabled: true, replies: false }), true, 'bubbles with nothing to float');
  assert.equal(bubbleOfferWanted({ ...state, bubbles: false }), false, 'before Android 11 there are none');
});
