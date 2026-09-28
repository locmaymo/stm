import type { ManagerRelease } from '../../../packages/contracts/src/index.js';

/** Where the dismissal is remembered, per browser. */
const SEEN_KEY = 'stm-update-seen';
/** The same, for the manager's own releases, which are a different question. */
const MANAGER_SEEN_KEY = 'stm-manager-update-seen';

type UpdateStorage = Pick<Storage, 'getItem' | 'setItem'>;

export { availableUpdate, type AvailableUpdate } from '../../../packages/contracts/src/index.js';

export function readDismissedUpdate(storage?: UpdateStorage): string | null {
  try {
    return storage?.getItem(SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveDismissedUpdate(ref: string, storage?: UpdateStorage): void {
  try {
    storage?.setItem(SEEN_KEY, ref);
  } catch {
    // Without storage the notice comes back next time, which is the safe way
    // round: a reminder nobody wanted beats a release nobody heard about.
  }
}

/**
 * Whether to show what the server found out about the manager's own version.
 *
 * The same rule as above and for the same reason, remembered under a key of
 * its own: the two are different programs on different release cycles, and
 * putting SillyTavern's newest version off should not also silence the notice
 * that the console itself has been replaced.
 *
 * The server has already decided whether there is anything to say - it reports
 * a release only when it is newer than the one running - so all that is left
 * here is whether this reader has already been told about this one.
 */
export function shouldShowManagerRelease(release: ManagerRelease | null, dismissed: string | null): boolean {
  if (!release) return false;
  return release.version !== dismissed;
}

export function readDismissedManagerRelease(storage?: UpdateStorage): string | null {
  try {
    return storage?.getItem(MANAGER_SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveDismissedManagerRelease(version: string, storage?: UpdateStorage): void {
  try {
    storage?.setItem(MANAGER_SEEN_KEY, version);
  } catch {
    // As above: the notice comes back, which is the harmless way to fail.
  }
}
