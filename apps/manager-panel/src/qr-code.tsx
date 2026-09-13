import qrcode from 'qrcode-generator';

/** A quiet zone is part of the format: without it a scanner cannot find the code. */
const QUIET_ZONE = 4;

/**
 * The dark modules of a QR code for `value`, as one SVG path.
 *
 * Error correction M survives a little glare on a phone camera without making
 * the modules noticeably smaller, and type 0 lets the library pick the smallest
 * version the text fits into.
 */
export function qrCodePath(value: string): { span: number; path: string } {
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();
  const modules = code.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (code.isDark(row, column)) cells.push(`M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return { span: modules + QUIET_ZONE * 2, path: cells.join('') };
}

/**
 * A scannable code for an address, drawn rather than fetched.
 *
 * Reading a link off a screen and typing it into a phone is the slowest part of
 * sharing one, and a Quick Tunnel address is a random subdomain nobody types
 * correctly first time. Drawing the modules as SVG needs no canvas, no network
 * and no image service that would see the address.
 */
export function QrCode({ value, label, size = 168 }: { value: string; label: string; size?: number }) {
  const { span, path } = qrCodePath(value);
  return (
    <svg className="qr-code" viewBox={`0 0 ${span} ${span}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={span} height={span} className="qr-quiet-zone" />
      <path d={path} className="qr-modules" />
    </svg>
  );
}
