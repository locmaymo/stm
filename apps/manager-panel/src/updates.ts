import type { Installation, ManagerRelease, VersionOption } from '../../../packages/contracts/src/index.js';

/** Where the dismissal is remembered, per browser. */
const SEEN_KEY = 'stm-update-seen';
/** The same, for the manager's own releases, which are a different question. */
const MANAGER_SEEN_KEY = 'stm-manager-update-seen';

type UpdateStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface AvailableUpdate {
  /** The ref the newest release resolves to, which is what gets dismissed. */
  readonly ref: string;
  /** What to call it on screen: the tag when there is one, else the ref. */
  readonly label: string;
}

/**
 * The newer release worth mentioning, or null when there is nothing to say.
 *
 * Someone who has deliberately stayed on an older version does not want to be
 * told about it every time they open the page, and someone who has not noticed
 * a release does want to be told once. Both are served by naming the release
 * rather than the fact of being behind: the notice carries the ref it is
 * about, dismissing it remembers that ref, and the next release is a different
 * ref and so says so again. Nobody is asked twice about the same version, and
 * nobody misses one.
 *
 * Staging is left alone entirely. It is a branch, not a release: it moves
 * under whoever is following it, and being behind it is its normal state
 * rather than news.
 */
export function availableUpdate(versions: readonly VersionOption[], installation: Installation | null | undefined): AvailableUpdate | null {
  if (!installation || installation.status !== 'ready') return null;
  if (installation.selector === 'staging') return null;
  const installed = installation.resolvedRef;
  if (!installed) return null;
  const newest = newestRelease(versions);
  if (!newest) return null;
  if (newest.ref === installed) return null;
  return { ref: newest.ref, label: newest.tag ?? newest.ref };
}

/**
 * What the release channel currently points at.
 *
 * `latest` is the pointer the server keeps for exactly this, so it is asked
 * first; the scan for a release-channel option is for a payload that predates
 * it or omits it.
 */
function newestRelease(versions: readonly VersionOption[]): VersionOption | null {
  const pointer = versions.find((option) => option.selector === 'latest');
  if (pointer) return pointer;
  return versions.find((option) => option.channel === 'release') ?? null;
}

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
