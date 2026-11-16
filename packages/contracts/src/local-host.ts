/**
 * Whether this hostname is one the reader reached without a platform in the
 * middle: this machine, or a device on the same network.
 *
 * Shared by the panel and the manager, which have to agree about it: the panel
 * decides from it whether it is being shown somewhere it should not stay, and
 * the manager decides from it whether a console with no password yet is
 * already an address on the internet.
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
