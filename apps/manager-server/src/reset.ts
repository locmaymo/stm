import { mkdir, rm } from 'node:fs/promises';
import { parse, resolve } from 'node:path';
import { logEvent, type LogSink } from '../../../packages/contracts/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

/**
 * The directories a reset empties, in the order it empties them.
 *
 * Everything this manager has ever been told is in one of these: the admin
 * password and the PIN in `state`, SillyTavern itself and its chats in
 * `profiles`, the backups in `archives`, and the record of what happened in
 * `logs`, `metrics` and `outbox`. `tmp` goes with them because a half-finished
 * install left in it is the one thing that could survive the wipe and then be
 * picked up by the manager that comes after it.
 *
 * `bin` is not here. What is in it is cloudflared - a program downloaded from
 * Cloudflare, the same one every install fetches, and not anything anybody
 * typed into this manager. Deleting it would cost a download on the next start
 * for no gain, and on Windows it is the one file that may still be held open a
 * moment after the tunnel it belonged to was stopped.
 */
export const RESET_DIRECTORIES = ['state', 'profiles', 'archives', 'logs', 'metrics', 'outbox', 'tmp'] as const;

export type ResetDirectory = typeof RESET_DIRECTORIES[number];

export interface ResetFailure {
  readonly directory: ResetDirectory;
  readonly path: string;
  readonly reason: string;
}

export interface ResetReport {
  /** The directories that are now empty. */
  readonly removed: readonly string[];
  /** The ones that would not go, with what the filesystem said about each. */
  readonly failures: readonly ResetFailure[];
}

/**
 * Whether a path is safe to delete the whole of.
 *
 * A wipe is the one operation here that cannot be taken back, and the paths it
 * is given come from the environment - `STM_DATA_DIR` is whatever somebody put
 * in a `.env` or a container spec. A filesystem root, or a drive letter, is
 * what an empty or malformed setting resolves to, and that is the one input
 * this must refuse rather than obey.
 */
function erasable(path: string): boolean {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  return absolute.length > root.length;
}

/**
 * Empty the manager's data directory, and leave it ready to be filled again.
 *
 * Each directory is removed whole and made again empty, rather than walked and
 * unlinked file by file: it is faster, it takes the directory's own permissions
 * and any stray file with it, and there is no state in between where half the
 * contents are gone and something has started reading the rest.
 *
 * One directory refusing to go does not stop the others. What a reset is for is
 * getting back to a manager that has nothing on it, and seven directories of
 * which six were emptied is much closer to that than stopping at the first
 * locked file - so every failure is collected and reported instead.
 */
export async function eraseManagerData(paths: PlatformPaths, logger: LogSink): Promise<ResetReport> {
  const removed: string[] = [];
  const failures: ResetFailure[] = [];
  const seen = new Set<string>();
  for (const directory of RESET_DIRECTORIES) {
    const path = paths[directory];
    const absolute = resolve(path);
    // `tmp` is the machine's own scratch directory on a hosted platform rather
    // than one under the data root, and on any platform two of these could be
    // pointed at the same place by hand. Emptying it twice is harmless; saying
    // so twice is noise.
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!erasable(absolute)) {
      failures.push({ directory, path: absolute, reason: 'that is the root of a filesystem, not a data directory' });
      continue;
    }
    try {
      await rm(absolute, { recursive: true, force: true });
      await mkdir(absolute, { recursive: true });
      removed.push(absolute);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      failures.push({ directory, path: absolute, reason });
    }
  }
  logger(failures.length === 0
    ? logEvent('manager.dataErased', `[manager] every file this manager kept was erased (${removed.length} directories)`, { count: removed.length })
    : logEvent('manager.dataPartlyErased', `[manager] ${removed.length} directories were erased and ${failures.length} would not go`, { count: removed.length, failed: failures.length }));
  for (const failure of failures) logger(`[manager] ${failure.path} could not be erased: ${failure.reason}`);
  return { removed, failures };
}
