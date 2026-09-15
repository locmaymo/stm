import qrcode from 'qrcode-generator';

/**
 * What the operator sees in the terminal once the manager is up.
 *
 * Starting it used to print four lines, three of which were for whoever was
 * debugging it - a missing `.env`, a gateway port, a bootstrap notice - with
 * the one address that matters last and in the same grey as the rest. Someone
 * who has just installed this has to find that address, get it onto their
 * phone, and know how to stop the thing again.
 *
 * Everything here is a pure function of its input so it can be tested without
 * a terminal, and nothing decides on its own whether colour is wanted: the
 * caller looks at the stream and says.
 */

export interface BannerAddress {
  readonly label: string;
  readonly url: string;
}

export interface BannerInput {
  readonly title: string;
  readonly addresses: readonly BannerAddress[];
  /** Shown only until an administrator password exists. */
  readonly setupCode?: { readonly label: string; readonly value: string } | undefined;
  /** The address to draw as a code, when there is room and colour to draw it. */
  readonly qr?: { readonly value: string; readonly caption: string } | undefined;
  readonly stopHint: string;
  /** False for a pipe or a log file: no escapes, no block characters. */
  readonly colour: boolean;
  /** Terminal columns. The code is dropped rather than wrapped when it will not fit. */
  readonly width?: number;
}

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const INDENT = '  ';
const DEFAULT_WIDTH = 80;

/** A quiet zone is part of the format: without it a scanner cannot find the code. */
const QUIET_ZONE = 4;

export function bootstrapBanner(input: BannerInput): string {
  const width = input.width ?? DEFAULT_WIDTH;
  const paint = (text: string, code: string) => input.colour ? `${code}${text}${RESET}` : text;
  const labels = [...input.addresses.map((address) => address.label), input.setupCode?.label ?? ''];
  const column = Math.max(0, ...labels.map((label) => label.length));
  const row = (label: string, value: string) => `${INDENT}${paint(label.padEnd(column), DIM)}  ${paint(value, BOLD)}`;

  const lines: string[] = [''];
  lines.push(`${INDENT}${paint(input.title, BOLD)}`);
  lines.push(`${INDENT}${paint((input.colour ? '─' : '-').repeat(Math.max(8, Math.min(width, 64) - INDENT.length)), DIM)}`);
  lines.push('');
  for (const address of input.addresses) lines.push(row(address.label, address.url));

  const code = input.qr && input.colour ? qrCodeLines(input.qr.value) : [];
  if (input.qr && code.length > 0 && codeWidth(code) + INDENT.length <= width) {
    lines.push('', ...code.map((line) => `${INDENT}${line}`), `${INDENT}${paint(input.qr.caption, DIM)}`);
  }

  lines.push('');
  if (input.setupCode) lines.push(row(input.setupCode.label, input.setupCode.value), '');
  lines.push(`${INDENT}${paint(input.stopHint, DIM)}`, '');
  return lines.join('\n');
}

/**
 * The code as half-height rows, in colours of its own.
 *
 * Two module rows share one line of text, because a code tall enough to be
 * scanned is otherwise taller than the window it is printed in and pushes the
 * addresses off the top. The colours are set explicitly rather than left to
 * the terminal's palette: a code drawn in the foreground colour comes out
 * inverted on a light terminal, and plenty of scanners refuse an inverted code.
 */
export function qrCodeLines(value: string): string[] {
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();
  const modules = code.getModuleCount();
  const span = modules + QUIET_ZONE * 2;
  const dark = (row: number, column: number): boolean => {
    const inside = row >= QUIET_ZONE && row < QUIET_ZONE + modules && column >= QUIET_ZONE && column < QUIET_ZONE + modules;
    return inside && code.isDark(row - QUIET_ZONE, column - QUIET_ZONE);
  };
  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = '';
    let pen = '';
    for (let column = 0; column < span; column += 1) {
      // The upper half block is painted in the foreground colour and the lower
      // half in the background, so one character carries two module rows.
      const foreground = dark(row, column) ? 30 : 37;
      const background = row + 1 < span && dark(row + 1, column) ? 40 : 47;
      const ink = `${ESC}[${foreground};${background}m`;
      if (ink !== pen) { line += ink; pen = ink; }
      line += '▀';
    }
    lines.push(`${line}${RESET}`);
  }
  return lines;
}

/** How many columns the drawn code occupies, escapes not counted. */
export function codeWidth(lines: readonly string[]): number {
  return Math.max(0, ...lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, '').length));
}
