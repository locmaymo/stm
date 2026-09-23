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
 * is worth suggesting.
 */

/** Where the answer to the address offer is remembered, per browser. */
const ANSWERED_KEY = 'stm-address-offer-answered';
/** Where a link of the console's own, asked for before setup, waits for it. */
const OWN_LINK_KEY = 'stm-own-link-after-setup';

type HostingStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether this hostname is one the reader reached without a platform in the
 * middle: this machine, or a device on the same network.
 */
export function isLocalHostname(hostname: string): boolean {
  // Both brackets, so `[::1]` is not left as `::1]`.
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  // A name ending in .local is mDNS, which does not leave the network it is on.
  if (host.endsWith('.local')) return true;
  const ipv6 = /^f[cd][0-9a-f]{2}:/u.test(host) || host.startsWith('fe80:');
  if (ipv6) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    // Carrier-grade NAT, which is the range Tailscale hands out.
    || (first === 100 && second >= 64 && second <= 127);
}

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

export interface AddressOfferInput {
  /** The address the console is being read at, from the browser. */
  readonly hostname: string;
  /** Whether the console is inside another page's frame. */
  readonly framed: boolean;
  /** Whether the reader has answered this offer before. */
  readonly answered: boolean;
}

/**
 * Whether to offer, before the password is set, to open the console at the
 * address it is being read at - in a tab of its own.
 *
 * A studio shows a new app inside its own page, in a frame. The address in
 * that frame is one the platform gave out for this app, and it is already a
 * working link to this console: opened in a tab of its own, it is the
 * console without the studio around it, reached the way the platform meant.
 * That is the first thing to offer, ahead of a link of the console's own,
 * which is a tunnel that has to be opened and kept up.
 *
 * Not asked of a console already in its own tab - it is already at that
 * address - nor on the reader's own machine or network, and asked once.
 */
export function shouldOfferPlatformAddress(input: AddressOfferInput): boolean {
  if (input.answered || !input.framed) return false;
  return !isLocalHostname(input.hostname);
}

export function readAddressOfferAnswered(storage?: HostingStorage): boolean {
  return readFlag(storage, ANSWERED_KEY);
}

export function saveAddressOfferAnswered(storage?: HostingStorage): void {
  writeFlag(storage, ANSWERED_KEY, true);
}

/**
 * Whether the reader asked for the console's own link before there was a
 * password to guard it with.
 *
 * The link refuses to open on a manager with no password, and the offer is
 * made before one is set - so the choice is remembered here and carried out
 * by the console once it is open.
 */
export function readOwnLinkWanted(storage?: HostingStorage): boolean {
  return readFlag(storage, OWN_LINK_KEY);
}

export function saveOwnLinkWanted(storage: HostingStorage | undefined, wanted: boolean): void {
  writeFlag(storage, OWN_LINK_KEY, wanted);
}

function readFlag(storage: HostingStorage | undefined, key: string): boolean {
  try {
    return storage?.getItem(key) === 'yes';
  } catch {
    return false;
  }
}

function writeFlag(storage: HostingStorage | undefined, key: string, value: boolean): void {
  try {
    storage?.setItem(key, value ? 'yes' : 'no');
  } catch {
    // Without storage the offer comes back next time. That is a card nobody
    // wanted rather than a console nobody can reach, so it is the safe way
    // round - and it is one press to answer again.
  }
}
