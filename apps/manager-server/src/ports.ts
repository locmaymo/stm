/**
 * The three ports this manager owns, and the rule that keeps them apart.
 *
 * Two of them are fixed for the life of the process: the console's own port and
 * the access gateway's are read from the environment at startup, because moving
 * the port you are currently connected through from a page served on it is a
 * way to lose the page. SillyTavern's is the one that can move while the
 * manager runs, so it is the one that has to be checked against the others.
 */

/** Where the console listens. `STM_PORT` moves it; a restart applies it. */
export const MANAGER_PORT = 7860 as const;
/** Where the access gateway listens. `STM_ACCESS_PORT` moves it. */
export const ACCESS_GATEWAY_PORT = 8001 as const;
/** What SillyTavern is started on unless the console has been told otherwise. */
export const SILLYTAVERN_PORT = 8000 as const;

/**
 * Ports below this need privileges on Unix that the manager does not ask for,
 * and taking one would fail at the moment SillyTavern is started rather than
 * at the moment the number was typed.
 */
const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65535;

/** Which of the manager's own ports a number would collide with, if any. */
export type PortHolder = 'manager' | 'access' | 'tunnel';

export class PortError extends Error {
  public readonly code: 'port_invalid' | 'port_conflict';
  /** Which port is already taken, for a message that names it. */
  public readonly holder: PortHolder | undefined;

  public constructor(code: PortError['code'], message: string, holder?: PortHolder) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.holder = holder;
  }
}

export interface ReservedPorts {
  readonly manager: number;
  readonly access: number;
}

/**
 * Check a port SillyTavern is being moved to, and answer it back.
 *
 * A port the manager already answers on is refused rather than allowed to fail
 * later: whichever of the two started second would find the address in use, and
 * the one that lost would be a service the reader was already using.
 */
export function checkSillyTavernPort(port: unknown, reserved: ReservedPorts): number {
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw new PortError('port_invalid', 'The port must be a whole number');
  }
  if (port < LOWEST_PORT || port > HIGHEST_PORT) {
    throw new PortError('port_invalid', `The port must be between ${LOWEST_PORT} and ${HIGHEST_PORT}`);
  }
  if (port === reserved.manager) {
    throw new PortError('port_conflict', `Port ${port} is the manager's own port`, 'manager');
  }
  if (port === reserved.access) {
    throw new PortError('port_conflict', `Port ${port} is the access gateway's port`, 'access');
  }
  return port;
}

/**
 * A port from the environment, or the default when it says nothing usable.
 *
 * An unreadable value falls back rather than refusing to start: the console not
 * coming up at all is a worse answer to a typo in `.env` than the console
 * coming up where it always does.
 */
export function portFromEnvironment(value: string | undefined, fallback: number): number {
  const parsed = Number((value ?? '').trim());
  if (!Number.isInteger(parsed) || parsed < LOWEST_PORT || parsed > HIGHEST_PORT) return fallback;
  return parsed;
}
