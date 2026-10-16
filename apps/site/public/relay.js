/**
 * Sends the browser from an OAuth sign-in back to the SillyTavern Manager it
 * started from.
 *
 * The OAuth provider only returns to a redirect registered on its client,
 * matched exactly, and a manager can be open on any address: this machine, the
 * LAN, a tunnel, a hosted workspace. So the registered redirect is this page, and
 * the manager puts its own origin in `state`. Nothing here is secret or stored:
 * the authorization code is useless without the PKCE verifier the manager kept.
 *
 * Because it forwards to an address it is handed, it only does so on its own for
 * addresses that can only be the reader's own machine or network: loopback and
 * private ranges. Anywhere else it shows the address and waits for a click, so
 * it cannot be used as a silent redirect to another site.
 *
 * Public names are never among them, tunnels included. A tunnel service's
 * domain admits anyone who starts a tunnel, and shared hosting admits every
 * tenant, so forwarding there on sight would hand a stranger a redirect out of
 * this page - and a page that silently sends sign-in codes to public addresses
 * is what a phishing page looks like to the browsers' safety checks. Managers
 * reached that way are one click away instead.
 */

export const CALLBACK_PATH = '/oauth/cloudflare/callback';

/**
 * One copy of this page per OAuth client, each at the address registered on
 * that client, each forwarding to the manager's route of the same path.
 */
export const CALLBACK_PATHS = [CALLBACK_PATH, '/oauth/google/callback'];

/** The manager route for the relay page at `pathname`, or null for any other page. */
export function callbackPathFor(pathname) {
  const path = String(pathname).replace(/(?:\.html|\/)$/, '');
  return CALLBACK_PATHS.includes(path) ? path : null;
}

/** Parameters passed on to the manager; nothing else from the query is forwarded. */
const FORWARDED = ['code', 'state', 'error', 'error_description'];

/** The manager's origin from `state`, or null if `state` is not one a manager wrote. */
export function originFromState(state) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(state)) return null;
  try {
    const padded = state.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(state.length / 4) * 4, '=');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))));
    if (!decoded || typeof decoded.n !== 'string' || typeof decoded.o !== 'string') return null;
    const origin = new URL(decoded.o);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null;
    if (origin.username || origin.password) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

/** Whether a manager plausibly runs here, so forwarding needs no confirmation. */
export function isUsualManagerHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.endsWith('.local')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 127 // loopback
    || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT, as Tailscale uses
}

/**
 * Where to send the browser, decided from the query the provider returned with.
 *
 * @returns {{ kind: 'invalid' } | { kind: 'forward', url: string, host: string, automatic: boolean }}
 */
export function decide(search, callbackPath = CALLBACK_PATH) {
  const params = new URLSearchParams(search);
  const origin = originFromState(params.get('state'));
  if (!origin || (!params.get('code') && !params.get('error'))) return { kind: 'invalid' };
  const target = new URL(callbackPath, origin);
  for (const name of FORWARDED) {
    const value = params.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }
  return { kind: 'forward', url: target.toString(), host: target.host, automatic: isUsualManagerHost(target.hostname) };
}

function show(document, id, visible) {
  const element = document.getElementById(id);
  if (element) element.hidden = !visible;
}

export function run(window, document) {
  const callbackPath = callbackPathFor(window.location.pathname);
  const decision = callbackPath ? decide(window.location.search, callbackPath) : { kind: 'invalid' };
  // The code is in this page's address. Take it out of history before leaving.
  window.history.replaceState(null, '', window.location.pathname);
  if (decision.kind === 'invalid') {
    show(document, 'working', false);
    show(document, 'invalid', true);
    return;
  }
  if (decision.automatic) {
    window.location.replace(decision.url);
    return;
  }
  show(document, 'working', false);
  show(document, 'confirm', true);
  const destination = document.getElementById('destination');
  if (destination) destination.textContent = decision.host;
  // After the click the manager may take a few seconds to answer; say that it
  // is on its way rather than leave a card whose button still looks pressable.
  document.getElementById('continue')?.addEventListener('click', () => {
    show(document, 'confirm', false);
    show(document, 'working', true);
    window.location.replace(decision.url);
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') run(window, document);
