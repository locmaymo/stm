import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleOfferAccepted, bubbleOfferDue, bubbleOfferSnoozed, bubbleOfferWanted } from '../src/bubble-offer.js';

const DAY = 24 * 60 * 60 * 1000;

test('chat bubbles are offered until "Not now", once more a fortnight later, then never', () => {
  const start = Date.UTC(2026, 9, 12);
  assert.equal(bubbleOfferDue(null, start), true, 'never answered: asked');
  const once = bubbleOfferSnoozed(null, start);
  assert.equal(bubbleOfferDue(once, start + 13 * DAY), false);
  assert.equal(bubbleOfferDue(once, start + 14 * DAY), true, 'asked once more');
  const twice = bubbleOfferSnoozed(once, start + 14 * DAY);
  assert.equal(bubbleOfferDue(twice, start + 400 * DAY), false, 'and then left alone');
  assert.equal(bubbleOfferDue('not json', start), true, 'an answer nobody can read is no answer');
  assert.equal(bubbleOfferDue(bubbleOfferAccepted(start), start + 400 * DAY), false, 'turned on once: turning them off later is not a reason to ask again');
});

test('there is something to offer only on a phone that floats bubbles, while they are not on', () => {
  const state = { replies: true, enabled: false, bubbles: true, allowed: true };
  assert.equal(bubbleOfferWanted(null), false, 'no app to ask');
  assert.equal(bubbleOfferWanted(state), true);
  assert.equal(bubbleOfferWanted({ ...state, enabled: true }), false, 'already on');
  assert.equal(bubbleOfferWanted({ ...state, enabled: true, replies: false }), true, 'bubbles with nothing to float');
  assert.equal(bubbleOfferWanted({ ...state, bubbles: false }), false, 'before Android 11 there are none');
});
