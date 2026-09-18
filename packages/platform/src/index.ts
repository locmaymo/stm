import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import type { PlatformKind } from '../../contracts/src/index.js';

const DEFAULT_IO_CONCURRENCY = 8;
const MAX_IO_CONCURRENCY = 64;

/**
 * How many file operations to keep in flight.
 *
 * Hosted studios put the profile on a network volume where one file operation
 * costs milliseconds of round trip rather than microseconds of disk time. One
 * file at a time leaves that volume almost idle, so writing 11,000 small chat
 * files takes minutes instead of seconds. Overlapping a handful of operations
 * hides the latency without flooding a local disk.
 */
export function ioConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.STM_IO_CONCURRENCY);
  if (Number.isSafeInteger(configured) && configured >= 1 && configured <= MAX_IO_CONCURRENCY) return configured;
  return DEFAULT_IO_CONCURRENCY;
}

/**
 * Run `worker` over `items` with a bounded pool, preserving the first failure.
 *
 * `slot` identifies the worker, so a caller can give each one its own resource
 * (a file handle, a buffer) instead of sharing one.
 */
export async function runPooled<T>(items: readonly T[], limit: number, worker: (item: T, slot: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let failed = false;
  let failure: unknown;
  const run = async (slot: number): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]!, slot);
      } catch (error: unknown) {
        if (!failed) { failed = true; failure = error; }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: size }, (_, slot) => run(slot)));
  if (failed) throw failure;
}

export interface IoLimiter {
  /** Run `operation` once a slot is free. */
  run: <R>(operation: () => Promise<R>) => Promise<R>;
}

/**
 * A shared gate for recursive walks.
 *
 * Nesting `runPooled` inside a recursion multiplies the limit at every level,
 * so a four-deep tree would put hundreds of operations in flight. One limiter
 * shared by the whole walk keeps the real ceiling where it was asked to be.
 */
export function createIoLimiter(limit: number): IoLimiter {
  const size = Math.max(1, limit);
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };
  return {
    run: async <R>(operation: () => Promise<R>): Promise<R> => {
      if (active >= size) await new Promise<void>((resolvePromise) => { waiting.push(resolvePromise); });
      active += 1;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

export interface PlatformPaths {
  readonly platform: PlatformKind;
  readonly root: string;
  readonly state: string;
  readonly profiles: string;
  readonly archives: string;
  readonly logs: string;
  readonly metrics: string;
  readonly outbox: string;
  readonly tmp: string;
  readonly bin: string;
}

export interface PlatformPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

function hasTruthyEnvironmentValue(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function detectPlatform(options: PlatformPathOptions = {}): PlatformKind {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (platform === 'linux' && (env.STM_DATA_DIR?.startsWith('/mnt/workspace') || existsSync('/mnt/workspace'))) {
    return 'modelscope';
  }
  if (hasTruthyEnvironmentValue(env.STM_DOCKER) || env.DOCKER_CONTAINER === 'true' || env.CONTAINER === 'docker') {
    return 'docker';
  }
  // Node built for Termux reports its own platform, which is the one signal
  // that survives a shell started without Termux's environment.
  if (platform === 'android' || (env.PREFIX && env.PREFIX.includes('com.termux'))) {
    return 'termux';
  }
  if (platform === 'win32') {
    return 'windows';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  return 'unknown';
}

function defaultRoot(kind: PlatformKind, options: PlatformPathOptions, env: NodeJS.ProcessEnv): string {
  const home = options.homeDirectory ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (env.STM_DATA_DIR) {
    return resolve(env.STM_DATA_DIR);
  }
  if (kind === 'modelscope') {
    return '/mnt/workspace/sillytavern-manager';
  }
  if (kind === 'docker') {
    return '/data/sillytavern-manager';
  }
  if (kind === 'termux') {
    return join(env.PREFIX ?? home, 'var', 'sillytavern-manager');
  }
  if (kind === 'windows') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'SillyTavernManager');
  }
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'sillytavern-manager');
}

/**
 * Filesystems that exist only for as long as the machine does.
 *
 * `tmpfs` and `ramfs` are memory with a directory tree drawn on it. `overlay`
 * and `aufs` are a container's own writable layer, which is created with the
 * container and thrown away with it - so a host that starts a fresh container
 * on every deploy, or after an idle period, starts it with an empty one. A
 * volume mounted into a container is a real filesystem and shows up as one
 * here, which is exactly the difference this is asking about.
 */
const EPHEMERAL_FILESYSTEMS = new Set(['overlay', 'overlayfs', 'aufs', 'tmpfs', 'ramfs']);

export interface StorageDurability {
  /** Whether what is written to the data directory is still there after a restart. */
  readonly durable: boolean;
  /** What the data directory turned out to be on, or null when it could not be read. */
  readonly filesystem: string | null;
}

/**
 * Whether this machine keeps what is written to it.
 *
 * Asked of the filesystem rather than of the platform's name, because the name
 * does not answer it: the same image is durable when somebody mounted a volume
 * at the data directory and not when nobody did, and no environment variable
 * says which happened. The mount table does.
 *
 * A machine that cannot be asked - anything without /proc/mounts, which is
 * every Windows and macOS install - is taken at its word. Saying "your data may
 * be wiped" to somebody whose data is on their own disk is worse than saying
 * nothing, and those are the platforms where nothing is the right answer.
 */
export function storageDurability(dataRoot: string, mountTable?: string): StorageDurability {
  const table = mountTable ?? readMountTable();
  if (table === null) return { durable: true, filesystem: null };
  const target = posixPath(dataRoot);
  let best: { point: string; filesystem: string } | null = null;
  for (const line of table.split('\n')) {
    // device mountpoint fstype options dump pass, with spaces and the escape
    // character itself written in octal.
    const fields = line.split(' ');
    if (fields.length < 3) continue;
    const point = unescapeMountPath(fields[1]!);
    const filesystem = fields[2]!;
    if (!(target === point || target.startsWith(point.endsWith('/') ? point : `${point}/`))) continue;
    // The deepest mount point covering the directory is the one it is on; the
    // root covers everything and is almost never the answer.
    if (!best || point.length > best.point.length) best = { point, filesystem };
  }
  if (!best) return { durable: true, filesystem: null };
  return { durable: !EPHEMERAL_FILESYSTEMS.has(best.filesystem), filesystem: best.filesystem };
}

/**
 * `dataRoot` as a path the mount table can be compared against.
 *
 * A mount table is a POSIX idea, so the paths in it are POSIX paths, and the
 * platform's own `resolve` is the wrong tool for meeting them: on Windows it
 * turns `/data` into `\\data`, which matches no mount point ever written. That
 * cost nothing in production - a machine with no /proc/mounts has already
 * returned above - but it did mean this could only be tested on the one
 * platform it runs on, and the test that caught it was a Windows CI run.
 *
 * A path that is already absolute is taken as written. Anything else is
 * resolved against the working directory first, which is a question only the
 * platform can answer.
 */
function posixPath(dataRoot: string): string {
  if (dataRoot.startsWith('/')) return posix.normalize(dataRoot);
  return posix.normalize(resolve(dataRoot).replace(/\\/gu, '/'));
}

function readMountTable(): string | null {
  try {
    return readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null;
  }
}

/** `/mnt/my\040volume` back to `/mnt/my volume`. */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

export function getPlatformPaths(options: PlatformPathOptions = {}): PlatformPaths {
  const env = options.env ?? process.env;
  const platform = detectPlatform(options);
  const root = defaultRoot(platform, options, env);
  const scratchRoot = env.STM_TMP_DIR
    ? resolve(env.STM_TMP_DIR)
    : platform === 'modelscope' || platform === 'docker'
      ? join(tmpdir(), 'sillytavern-manager')
      : join(root, 'tmp');
  return {
    platform,
    root,
    state: join(root, 'state'),
    profiles: join(root, 'profiles'),
    archives: join(root, 'archives'),
    logs: join(root, 'logs'),
    metrics: join(root, 'metrics'),
    outbox: join(root, 'outbox'),
    tmp: scratchRoot,
    bin: join(root, 'bin'),
  };
}
