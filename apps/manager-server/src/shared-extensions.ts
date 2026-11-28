import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { logEvent, type LogSink } from '../../../packages/contracts/src/index.js';

/**
 * Extensions installed "for all users", moved into the profile.
 *
 * SillyTavern offers two places to install an extension. "Just for me" puts it
 * in the user's own folder, which is part of the profile: it is backed up, and
 * it goes to the owner's other devices. "For all users" puts it in the
 * installation itself, beside SillyTavern's own files - which no backup holds,
 * which no other device ever sees, and which installing another SillyTavern
 * version throws away. Nearly everybody here is one person on their own
 * SillyTavern, for whom the two buttons mean the same thing; the second one
 * only looked like the extension had stopped syncing.
 *
 * So an extension found there is moved to the user's folder, where SillyTavern
 * finds it just the same: it serves both folders at one address and prefers
 * the user's when a name is in both. Nothing has to be explained or chosen.
 *
 * Left alone: a SillyTavern with more than one user, for whom "all users"
 * means what it says, and an extension whose name the user already has.
 */

/** How long an extension's folder has to have been still before it is moved. */
const SETTLED_MS = 10_000;

export interface AdoptOptions {
  readonly runtimePath: string;
  /** The user's own data folder, such as `data/default-user`. */
  readonly userRoot: string;
  readonly logger?: LogSink;
  readonly now?: () => number;
}

/** Move what can be moved; the names moved. Never throws: it is a convenience. */
export async function adoptSharedExtensions(options: AdoptOptions): Promise<string[]> {
  const logger = options.logger ?? (() => undefined);
  const now = options.now ?? Date.now;
  const shared = join(options.runtimePath, 'public', 'scripts', 'extensions', 'third-party');
  const own = join(options.userRoot, 'extensions');
  let names: string[];
  try {
    names = await readdir(shared);
  } catch {
    return [];
  }
  if (names.length === 0 || !await onlyUser(options.userRoot)) return [];
  const moved: string[] = [];
  for (const name of names) {
    const from = join(shared, name);
    const to = join(own, name);
    try {
      if (!await movable(from, now())) continue;
      if (await present(to)) continue;
      await mkdir(own, { recursive: true });
      await moveFolder(from, to);
      moved.push(name);
      logger(logEvent('extensions.adopted', `[extensions] ${name} was installed for all users; it now lives in this profile, so it is backed up and goes to your other devices`, { name }));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      logger(logEvent('extensions.adoptFailed', `[extensions] ${name} could not be moved into this profile: ${reason}`, { name, reason }));
    }
  }
  return moved;
}

/**
 * Whether this SillyTavern has one user, the one whose folder this is.
 *
 * SillyTavern keeps each user's data in a folder named after them and its own
 * bookkeeping in folders whose names start with an underscore.
 */
async function onlyUser(userRoot: string): Promise<boolean> {
  const dataRoot = dirname(userRoot);
  try {
    const entries = await readdir(dataRoot, { withFileTypes: true });
    const users = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'));
    return users.length === 1 && users[0]?.name === basename(userRoot);
  } catch {
    return false;
  }
}

/**
 * An extension SillyTavern would load, not being written to right now.
 *
 * Installing one is a `git clone` into this folder, and updating it a `git
 * pull`. Either holds a lock file in `.git` while it writes, and the manifest
 * is among the last files to appear, so a folder with a manifest, no lock and
 * nothing touched for a few seconds is one that has finished arriving.
 */
async function movable(folder: string, now: number): Promise<boolean> {
  const details = await lstat(folder);
  if (!details.isDirectory() || details.isSymbolicLink()) return false;
  const manifest = await stat(join(folder, 'manifest.json')).catch(() => null);
  if (!manifest?.isFile()) return false;
  if (now - Math.max(details.mtimeMs, manifest.mtimeMs) < SETTLED_MS) return false;
  const git = await readdir(join(folder, '.git')).catch(() => [] as string[]);
  return !git.some((name) => name.endsWith('.lock'));
}

async function present(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, () => false);
}

/** Renamed where it can be; copied and then removed where the two folders are on different disks. */
async function moveFolder(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}
