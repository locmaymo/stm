/**
 * Whether the console is being read somewhere its own address may not work.
 *
 * On a laptop or a phone the console is opened at a loopback address, or at a
 * LAN address from another device in the house. Both are addresses the reader
 * already has and that already work, so there is nothing to offer them.
 *
 * Hosted is the other case: a workspace, a forwarded port, a preview frame
 * whose real address is a URL nobody is shown. There the address in the bar is
 * the platform's, it can be scoped to a session, rewritten in the headers the
 * console reads itself from, or simply gone tomorrow - and a Cloudflare
 * sign-in has to come back to something. That is when the console's own link
 * is what the reader is sent to.
 */

import { isLocalHostname, type OwnLinkState } from '../../../packages/contracts/src/index.js';
import { publicAddress } from './addresses.js';

// Whether a hostname was reached without a platform in the middle. Kept with
// the contracts because the manager asks the same question; see there.
export { isLocalHostname };

/**
 * Whether this hostname is the machine the console is running on.
 *
 * Narrower than `isLocalHostname`, and a different question: that one asks
 * whether the reader got here without a platform in the middle, which a phone
 * on the same Wi-Fi did. This asks whether the reader is *on* the machine - the
 * only place a loopback address means anything, and the only place SillyTavern
 * can be shown in a frame on this console's own origin.
 *
 * Written out rather than compared against two strings, because `[::1]` and
 * `127.0.0.2` are this machine too and were being treated as somewhere else.
 */
export function isThisMachine(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host === '') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

export interface FrameInput {
  /** The address the console is being read at, from the browser. */
  readonly hostname: string;
  /** Whether the console is inside another page's frame. */
  readonly framed: boolean;
}

/**
 * Whether the console is somewhere it should send the reader away from: in a
 * platform's frame.
 *
 * A studio shows a new app inside its own page, and a console inside somebody
 * else's page does not work everywhere. On an older phone the page draws and
 * then nothing on it can be pressed and nothing it asks for comes back, which
 * to the reader is an installer that is broken. The same console at a link of
 * its own, in a tab of its own, has none of that - so the frame shows that
 * link and nothing else, to everybody, rather than working for some readers
 * and failing for the rest in a way none of them can report.
 *
 * It used to be an offer, made once, with the platform's own address first.
 * That address is not always one a browser can stay at - a platform may send
 * it straight back to the page with the frame in it - and an offer that can be
 * skipped is skipped by exactly the reader it was for.
 *
 * Not on the reader's own machine or network: a frame there is one somebody
 * built on purpose, around an address that works.
 */
export function mustLeaveFrame(input: FrameInput): boolean {
  return input.framed && !isLocalHostname(input.hostname);
}

/** What the frame shows while it is sending the reader to the link. */
export type OwnLinkView =
  | { readonly kind: 'link'; readonly address: string }
  | { readonly kind: 'opening' }
  | { readonly kind: 'failed'; readonly error: string | null }
  /** No link is coming and none can be asked for: the form is all there is. */
  | { readonly kind: 'stay' };

/**
 * Read what the manager said about its link.
 *
 * `stay` is the way out for a reader nothing else would let in: the link is
 * off on a console that has an owner, who is the only one who can turn it on,
 * or the console does not think it is on the internet at all. A link that
 * failed on a blank console is `failed` instead, because there asking again
 * may well work.
 */
export function ownLinkView(state: OwnLinkState): OwnLinkView {
  const address = publicAddress(state);
  if (address) return { kind: 'link', address };
  if (state.opening || state.status === 'starting' || state.status === 'running') return { kind: 'opening' };
  if (!state.available) return { kind: 'stay' };
  if (state.status === 'error') return { kind: 'failed', error: state.error };
  // Blank, asked for, and not started: the ask did not take. Said as a
  // failure so there is a button to ask again with.
  return { kind: 'failed', error: null };
}
