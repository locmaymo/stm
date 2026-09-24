import { DEFAULT_ACCESS_LINK, type AccessGatewayState, type AccessLinkKind, type TunnelState } from '../../../packages/contracts/src/index.js';

/**
 * SillyTavern itself, which only this machine can reach.
 *
 * The port is asked for rather than assumed: it used to be written in here as
 * 8000, so moving SillyTavern left every link on the overview pointing at a
 * port it had left.
 */
export function localHost(sillyTavernPort: number): string {
  return `127.0.0.1:${sillyTavernPort}`;
}

/** What a tunnel's public address is read from, whichever card is asking. */
export type PublicTunnel = Pick<TunnelState, 'url' | 'proxyUrl' | 'proxyPending' | 'linkPreference'>;

/**
 * The public address to put in front of a reader, or null while there is none.
 *
 * Null covers two different waits, and deliberately does not distinguish them:
 * a tunnel that has not announced itself yet, and one that has while the fixed
 * Worker address in front of it is still being deployed. Both mean the same
 * thing to whoever is looking at the card - the link is coming - and showing an
 * address during either of them is showing one that is about to be replaced or
 * that answers with an error. This is the only place that decision is made, so
 * the overview, the sharing card, the QR code, the embedded window and the
 * console's own link cannot disagree about it.
 *
 * Which of the two goes first is the reader's; see `AccessLinkPreference`.
 */
export function publicAddress(tunnel: PublicTunnel): string | null {
  return publicLinks(tunnel)[0]?.url ?? null;
}

/** One public address of a door, and which kind it is. */
export interface PublicLink {
  readonly kind: AccessLinkKind;
  readonly url: string;
}

/**
 * Every public address of a door, the preferred one first.
 *
 * The fixed address only while the reader has not hidden it. While it is still
 * being deployed and it is the one preferred, there is nothing to offer yet -
 * the tunnel's own address standing in for a few seconds is an address about
 * to be replaced.
 */
export function publicLinks(tunnel: PublicTunnel): PublicLink[] {
  const preference = tunnel.linkPreference ?? DEFAULT_ACCESS_LINK;
  const fixed: PublicLink | null = preference.showFixed && tunnel.proxyUrl ? { kind: 'fixed', url: tunnel.proxyUrl } : null;
  const own: PublicLink | null = tunnel.url ? { kind: 'tunnel', url: tunnel.url } : null;
  if (preference.preferred === 'tunnel' || !preference.showFixed) return [own, fixed].filter((link): link is PublicLink => link !== null);
  if (tunnel.proxyPending) return [];
  return [fixed, own].filter((link): link is PublicLink => link !== null);
}

/** One place SillyTavern answers, as a link and as something short enough to show. */
export interface ReachableAddress {
  readonly kind: 'tunnel' | 'lan' | 'local';
  /** For a public address, whether it is the fixed one or the tunnel's own. */
  readonly link?: AccessLinkKind;
  readonly url: string;
  /** The URL without its scheme, which is all a reader needs to recognise it. */
  readonly host: string;
  /**
   * Where this address actually forwards to, when it is not itself the door.
   *
   * Set only for the fixed Worker address: the traffic goes through it to
   * whatever Quick Tunnel is up at the time, and that tunnel's own address is
   * worth being able to see - it is what the logs say and what is actually
   * being proxied - without being the address anybody is offered.
   */
  readonly via?: string;
}

/**
 * Every address SillyTavern can be opened at right now, best first.
 *
 * The tunnel reaches it from anywhere, the network address from anything in
 * the house, and the loopback address only from the machine it is on - so that
 * is the order a link is chosen in. The console used to open the loopback
 * address whatever else was on, which from a phone is an address that goes
 * nowhere.
 *
 * `networkHost` is this machine's own address on the network around it, and
 * null when it has none - a hosted container has no Wi-Fi to be on. It used
 * to fall back to the address in the reader's browser, which is where the
 * *reader* is and says nothing about where this machine can be reached: on a
 * hosted studio that produced `some-app.hosted.example:8001`, offered as "on this
 * Wi-Fi" though the platform serves no such port and the reader's phone is on
 * another network entirely. No address is the honest answer.
 *
 * `onThisMachine` is whether the console is being read on the machine it is
 * running on, and it decides whether the loopback address is an address at all.
 * It is not, anywhere else: not from a phone on the same Wi-Fi, and least of
 * all on a hosted studio, where the console is a page served from a container
 * in a data centre and `127.0.0.1` is the reader's own laptop. Offered there,
 * it was a link that could only ever fail, shown as the best address available
 * and used by the Open button - so the one press that was supposed to open
 * SillyTavern was the one press guaranteed not to. An empty list is the honest
 * answer, and the console can then offer the thing that would actually work.
 */
export function reachableAddresses(tunnel: PublicTunnel, security: Pick<AccessGatewayState, 'lan' | 'port'>, networkHost: string | null, sillyTavernPort: number, onThisMachine: boolean): ReachableAddress[] {
  const addresses: ReachableAddress[] = [];
  /*
   * The fixed address wins over the tunnel's own.
   *
   * A Quick Tunnel's hostname is a different one every time cloudflared
   * starts, so it is the wrong thing to put in front of somebody: the link
   * they save, send or scan stops working the next time the machine is
   * restarted, and stops as `DNS_PROBE_FINISHED_NXDOMAIN`. The Worker address
   * is the same one for good, and forwards to whichever tunnel is up. Where
   * there is no Cloudflare sign-in there is no Worker, and the tunnel's own
   * address is the only address there is.
   *
   * While that Worker is being deployed there is no public address at all
   * here, rather than the tunnel's own standing in for a few seconds. A reader
   * on a machine of their own still has the network and loopback addresses
   * below, which work; a reader on a hosted studio has none, which is the
   * honest answer and the one the card is built to say.
   */
  // Both public addresses, the preferred one first: the second is still an
  // address that works, and the card offers it behind a "+1".
  for (const link of publicLinks(tunnel)) {
    const via = link.kind === 'fixed' && tunnel.url ? { via: bareHost(tunnel.url) } : {};
    addresses.push({ kind: 'tunnel', link: link.kind, url: link.url, host: bareHost(link.url), ...via });
  }
  if (security.lan && networkHost) {
    const host = `${networkHost}:${security.port}`;
    addresses.push({ kind: 'lan', url: `http://${host}`, host });
  }
  if (!onThisMachine) return addresses;
  const local = localHost(sillyTavernPort);
  addresses.push({ kind: 'local', url: `http://${local}`, host: local });
  return addresses;
}

/** An address as a reader recognises it: no scheme, no trailing slash. */
export function bareHost(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
}

/**
 * `sillytavern.acme.workers.dev` as `silly...workers.dev`.
 *
 * The beginning says which address it is and the end says what kind: the last
 * two labels of the name where they are short enough to read at a glance, and
 * their last nine characters where they are not - `good...flare.com`. The
 * middle is what a phone has no room for; the whole address is one tap away.
 */
export function shortenHost(host: string): string {
  const head = 5;
  // An IP address with its middle taken out is no address at all, and it is
  // never long enough to need it.
  if (/^[0-9.:]+$/u.test(host)) return host;
  const domain = host.split('.').slice(-2).join('.');
  const tail = domain.length <= 12 ? domain : domain.slice(-9);
  return host.length > head + tail.length + 5 ? `${host.slice(0, head)}...${tail}` : host;
}

/**
 * What another machine on the account is called, fit for a sentence.
 *
 * Usually its hostname, which is short. Where that said nothing the manager
 * names the machine by the address it was opened at instead, which is long -
 * and only its two ends are worth reading. More of each end than
 * `shortenHost` keeps: this is read in a sentence, not squeezed onto a button.
 */
export function machineName(label: string): string {
  const keep = 12;
  return label.includes('.') && label.length > keep * 2 + 3 ? `${label.slice(0, keep)}...${label.slice(-keep)}` : label;
}
