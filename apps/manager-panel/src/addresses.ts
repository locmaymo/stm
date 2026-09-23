import type { AccessGatewayState, TunnelState } from '../../../packages/contracts/src/index.js';

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
export type PublicTunnel = Pick<TunnelState, 'url' | 'proxyUrl' | 'proxyPending'>;

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
 */
export function publicAddress(tunnel: PublicTunnel): string | null {
  if (tunnel.proxyPending) return null;
  return tunnel.proxyUrl ?? tunnel.url ?? null;
}

/** One place SillyTavern answers, as a link and as something short enough to show. */
export interface ReachableAddress {
  readonly kind: 'tunnel' | 'lan' | 'local';
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
  const publicUrl = publicAddress(tunnel);
  if (publicUrl) {
    const via = tunnel.proxyUrl && tunnel.url ? { via: bareHost(tunnel.url) } : {};
    addresses.push({ kind: 'tunnel', url: publicUrl, host: bareHost(publicUrl), ...via });
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
 * `example.trycloudflare.com` as `exam...flare.com`.
 *
 * The beginning says which tunnel it is and the end says what kind of address
 * it is; the middle is what a phone has no room for. The full address is in
 * the remote access card, one card further down.
 */
export function shortenHost(host: string): string {
  const head = 4;
  const tail = 9;
  // An IP address with its middle taken out is no address at all, and it is
  // never long enough to need it.
  if (/^[0-9.:]+$/u.test(host)) return host;
  return host.length > head + tail + 5 ? `${host.slice(0, head)}...${host.slice(-tail)}` : host;
}
