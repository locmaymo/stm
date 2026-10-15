/**
 * A proxy address as people actually have it, turned into the one SillyTavern
 * reads.
 *
 * Proxy sellers hand them out in whatever order their dashboard prints:
 * `ip:port:user:pass`, `user:pass@ip:port`, `ip:port@user:pass`,
 * `user:pass:ip:port`, with or without `http://` in front, sometimes with
 * spaces where the colons go. SillyTavern only understands a URL -
 * `http://user:pass@ip:port` - and says nothing but a line in its own log
 * when it is given anything else: every request then goes out directly, which
 * is the one thing somebody setting a proxy did not want. So whatever was
 * pasted is read here, and what is saved is always the URL.
 */

/** The kinds offered in the console, the first being what an address without one is taken as. */
export const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks4'] as const;
export type ProxyScheme = typeof PROXY_SCHEMES[number];

/** Every kind SillyTavern's proxy library speaks, whether or not it is offered. */
const KNOWN_SCHEMES = new Set(['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

/** What SillyTavern ships in `requestProxy.url`, which is an example and not a proxy. */
const SHIPPED_EXAMPLE = 'socks5://username:password@example.com:1080';

export type ProxyProblem = 'scheme' | 'host' | 'port';

export type ProxyReading =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: ProxyProblem };

/**
 * Read a pasted proxy address. Empty text is not read here; it means no proxy.
 *
 * `scheme` is what an address that names none is taken as - the kind chosen
 * beside the box. One that does name a kind keeps it.
 */
export function readProxy(input: string, scheme: string = PROXY_SCHEMES[0]): ProxyReading {
  let text = input.trim().replace(/^['"`]+|['"`]+$/gu, '').trim();
  // A PAC file picks the proxy itself, and is used as it was given.
  if (/^pac\+https?:\/\//iu.test(text)) return validUrl(text) ? { ok: true, url: text } : { ok: false, problem: 'host' };
  const named = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(text);
  let kind = scheme.toLowerCase();
  if (named?.[1]) {
    kind = named[1].toLowerCase();
    text = text.slice(named[0].length);
  }
  if (!KNOWN_SCHEMES.has(kind)) return { ok: false, problem: 'scheme' };
  // Spaces where the colons go, as some lists print them, and the slash a
  // copied link ends with.
  text = text.replace(/\/+$/u, '').split(/\s+/u).filter(Boolean).join(':');
  const found = findHost(text);
  if (!found.ok) return found;
  const { host, port, credentials } = found;
  const separator = credentials.indexOf(':');
  const username = separator === -1 ? credentials : credentials.slice(0, separator);
  const password = separator === -1 ? '' : credentials.slice(separator + 1);
  const auth = username ? `${encode(username)}${password ? `:${encode(password)}` : ''}@` : '';
  const url = `${kind}://${auth}${host.toLowerCase()}:${port}`;
  return validUrl(url) ? { ok: true, url } : { ok: false, problem: 'host' };
}

type HostReading = { readonly ok: true; readonly host: string; readonly port: string; readonly credentials: string } | { readonly ok: false; readonly problem: ProxyProblem };

function findHost(text: string): HostReading {
  if (text.includes('@')) {
    // The usual order, credentials first; split at the last @ so a password
    // with one in it stays whole.
    const last = text.lastIndexOf('@');
    const after = hostPort(text.slice(last + 1));
    if (after) return { ok: true, ...after, credentials: text.slice(0, last) };
    // The other order, `ip:port@user:pass`.
    const first = text.indexOf('@');
    const before = hostPort(text.slice(0, first));
    if (before) return { ok: true, ...before, credentials: text.slice(first + 1) };
    // Neither: the @ is inside a password, in one of the orders below.
    const colons = byColons(text);
    return colons.ok ? colons : { ok: false, problem: problemWith(text.slice(last + 1)) };
  }
  return byColons(text);
}

function byColons(text: string): HostReading {
  const parts = splitParts(text);
  if (parts.length < 2) return { ok: false, problem: problemWith(text) };
  if (parts.length === 2) {
    const alone = hostPort(`${parts[0]}:${parts[1]}`);
    return alone ? { ok: true, ...alone, credentials: '' } : { ok: false, problem: problemWith(text) };
  }
  // `ip:port:user:pass` or `user:pass:ip:port`. Where both readings fit, the
  // one whose host looks like an address wins, and the first order otherwise
  // - it is by far the more common.
  const first = hostPort(`${parts[0]}:${parts[1]}`);
  const last = parts.length >= 4 ? hostPort(`${parts.at(-2)}:${parts.at(-1)}`) : null;
  const pick = first && last ? (looksLikeAddress(first.host) || !looksLikeAddress(last.host) ? 'first' : 'last') : first ? 'first' : last ? 'last' : null;
  if (pick === 'first' && first) return { ok: true, ...first, credentials: parts.slice(2).join(':') };
  if (pick === 'last' && last) return { ok: true, ...last, credentials: parts.slice(0, -2).join(':') };
  return { ok: false, problem: isPort(parts[1] ?? '') || isPort(parts.at(-1) ?? '') ? 'host' : 'port' };
}

/** Colon-separated parts, keeping a bracketed IPv6 address in one. */
function splitParts(text: string): string[] {
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close !== -1 && text[close + 1] === ':') return [text.slice(0, close + 1), ...text.slice(close + 2).split(':')];
    if (close !== -1) return [text];
  }
  return text.split(':');
}

const HOST_PATTERN = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/iu;

function hostPort(text: string): { host: string; port: string } | null {
  const colon = text.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = text.slice(0, colon);
  const port = text.slice(colon + 1);
  return HOST_PATTERN.test(host) && isPort(port) ? { host, port } : null;
}

/** An IP address or a name with a dot in it, as opposed to a word that could be a user name. */
function looksLikeAddress(host: string): boolean {
  return host.startsWith('[') || host.includes('.') || host.toLowerCase() === 'localhost';
}

function isPort(text: string): boolean {
  return /^\d{1,5}$/u.test(text) && Number(text) >= 1 && Number(text) <= 65535;
}

/** Whether what is wrong is the host or the port, for the line that says so. */
function problemWith(text: string): ProxyProblem {
  const colon = text.lastIndexOf(':');
  if (colon === -1) return HOST_PATTERN.test(text) ? 'port' : 'host';
  return isPort(text.slice(colon + 1)) ? 'host' : 'port';
}

/** Credentials as they were meant, whether or not the paste had them encoded already. */
function encode(text: string): string {
  let plain = text;
  try { plain = decodeURIComponent(text); } catch { /* a lone % is part of the password */ }
  return encodeURIComponent(plain);
}

function validUrl(text: string): boolean {
  try { return new URL(text).hostname !== ''; } catch { return false; }
}

/**
 * The address with its password hidden, for showing on a screen somebody
 * else might be looking at.
 */
export function maskProxy(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return url;
    return `${parsed.protocol}//${parsed.username}:•••@${parsed.host}`;
  } catch { return url; }
}

/** The kind an address names, when it is one of those offered. */
export function proxySchemeOf(url: string): ProxyScheme | null {
  const named = /^([a-z0-9]+):\/\//iu.exec(url)?.[1]?.toLowerCase();
  return PROXY_SCHEMES.find((scheme) => scheme === named) ?? null;
}

/**
 * The address the console treats the file as holding: none, where all it
 * holds is the example SillyTavern ships.
 */
export function savedProxy(url: string): string {
  return url.trim() === SHIPPED_EXAMPLE ? '' : url;
}
