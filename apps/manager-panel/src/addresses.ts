import type { AccessGatewayState, TunnelState } from '../../../packages/contracts/src/index.js';

/** SillyTavern itself, which only this machine can reach. */
export const LOCAL_HOST = '127.0.0.1:8000';

/** One place SillyTavern answers, as a link and as something short enough to show. */
export interface ReachableAddress {
  readonly kind: 'tunnel' | 'lan' | 'local';
  readonly url: string;
  /** The URL without its scheme, which is all a reader needs to recognise it. */
  readonly host: string;
}

/**
 * Every address SillyTavern can be opened at right now, best first.
 *
 * The tunnel reaches it from anywhere, the network address from anything in
 * the house, and the loopback address only from this machine - so that is the
 * order a link is chosen in. The console used to open the loopback address
 * whatever else was on, which from a phone is an address that goes nowhere.
 */
export function reachableAddresses(tunnel: Pick<TunnelState, 'url'>, security: Pick<AccessGatewayState, 'lan' | 'port'>, networkHost: string): ReachableAddress[] {
  const addresses: ReachableAddress[] = [];
  if (tunnel.url) addresses.push({ kind: 'tunnel', url: tunnel.url, host: tunnel.url.replace(/^https?:\/\//u, '').replace(/\/$/u, '') });
  if (security.lan) {
    const host = `${networkHost}:${security.port}`;
    addresses.push({ kind: 'lan', url: `http://${host}`, host });
  }
  addresses.push({ kind: 'local', url: `http://${LOCAL_HOST}`, host: LOCAL_HOST });
  return addresses;
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
