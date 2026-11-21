import { CHUNK_BYTES, type HashedFile } from './sync.js';

/**
 * What a device has to do to its own files to catch up with the others.
 *
 * One person uses several devices, one at a time, over one set of data. Each
 * device remembers the file list it last agreed on with storage (its base).
 * When it comes back, storage may have moved on (the head), the device may
 * have changed things itself (local), or both. This works out, file by file,
 * what to do about that.
 *
 * Nothing here merges the inside of a file. SillyTavern rewrites its files
 * whole, so a file is one side's version or the other's, and when both sides
 * changed it the choice is to keep both, never to stitch them together.
 *
 * It does no IO. The caller uploads the local state as a recovery point before
 * applying anything, which is why "the head wins" below never loses anything:
 * the version that lost is already in storage.
 */
export interface SyncPlanInput {
  /** The file list this device and storage last agreed on, or null on a device that has never synced. */
  readonly base: readonly HashedFile[] | null;
  /** What is on this device now. */
  readonly local: readonly HashedFile[];
  /** The newest file list in storage. */
  readonly head: readonly HashedFile[];
  /**
   * What tells this device's copy of a chat from the other one, as it will
   * appear in the file name: a device label and a time, already formatted.
   */
  readonly copyTag: string;
  /** Whether this device's file system rejects the names Windows rejects. */
  readonly windowsNames: boolean;
  /** Whether this device's file system treats `A.png` and `a.png` as one file. */
  readonly caseInsensitive: boolean;
}

export type SyncAction =
  /** Write the head's version here, over whatever is there. */
  | { readonly kind: 'take'; readonly name: string; readonly file: HashedFile }
  /** Delete the file here; another device deleted it and this one never touched it. */
  | { readonly kind: 'remove'; readonly name: string }
  /**
   * Both sides changed a chat. The head's version takes the name, and this
   * device's version becomes a second chat next to it, so both can be read.
   */
  | {
    readonly kind: 'keepBoth';
    readonly name: string;
    readonly as: string;
    readonly head: HashedFile;
    readonly local: HashedFile;
    readonly chat: 'character' | 'group';
    /**
     * The side that may be the other one with more added at the end. Chunk
     * hashes cannot settle it for the last, partly filled chunk, so whoever
     * applies the plan compares the bytes and, if it holds, keeps just the
     * longer file instead of two.
     */
    readonly mayExtend: 'local' | 'head' | null;
  }
  /**
   * Both sides changed something that cannot exist twice (settings, a
   * character card). The head's version is written here; this device's
   * version stays in the recovery point taken before the plan was applied.
   */
  | { readonly kind: 'setAside'; readonly name: string; readonly head: HashedFile; readonly local: HashedFile };

export type SkipReason =
  /** The name could put a file outside the profile. */
  | 'unsafe_name'
  /** This device's file system cannot hold a file with this name. */
  | 'invalid_name'
  /** This device already holds a different file whose name differs only by case. */
  | 'case_collision';

export interface SyncPlan {
  /** Removals first, then everything that writes, each group in name order. */
  readonly actions: readonly SyncAction[];
  /**
   * Head files this device cannot hold. Its next file list must carry them
   * unchanged: a list built from the disk alone would not have them, and the
   * other devices would read that as this one deleting them.
   */
  readonly carried: readonly HashedFile[];
  readonly skipped: readonly { readonly name: string; readonly reason: SkipReason }[];
  /** Whether this device will hold something storage does not, once the plan is applied. */
  readonly push: boolean;
}

/**
 * Files that describe the device, not the person.
 *
 * `config.yaml` carries the port and the listen address, which the manager
 * sets per device before every start. It stays in each device's recovery
 * points but is never taken from, or deleted because of, another device.
 */
const DEVICE_FILES = new Set(['config.yaml', 'config.yml']);

const CHARACTER_CHAT = /^chats\/.+\.jsonl$/iu;
const GROUP_CHAT = /^group chats\/.+\.jsonl$/iu;

/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/u;
// eslint-disable-next-line no-control-regex
const TAG_FORBIDDEN = /[<>:"|?*\\/\u0000-\u001f]/gu;

/** The longest file name, in UTF-8 bytes, that every file system in use accepts with room to spare. */
const MAX_NAME_BYTES = 200;
const MAX_TAG_CHARS = 60;

export function planSync(input: SyncPlanInput): SyncPlan {
  const base = input.base === null ? null : index(input.base);
  const local = index(input.local);
  const head = index(input.head);
  const names = [...new Set([...local.keys(), ...head.keys()])].sort(byName);

  const removals: SyncAction[] = [];
  const writes: SyncAction[] = [];
  const carried: HashedFile[] = [];
  const skipped: { name: string; reason: SkipReason }[] = [];
  let push = false;

  /**
   * Names that will be on this device afterwards, for telling a copy's name
   * and a case collision apart from a file that is merely being replaced.
   */
  const staying = new Map<string, string>();
  const fold = (name: string): string => (input.caseInsensitive ? name.toLowerCase() : name);
  const decided: { name: string; mine: HashedFile | undefined; theirs: HashedFile | undefined; was: HashedFile | undefined }[] = [];

  for (const name of names) {
    const mine = local.get(name);
    const theirs = head.get(name);
    const was = base?.get(name);
    if (DEVICE_FILES.has(name)) continue;
    decided.push({ name, mine, theirs, was });
    // A local file stays unless the head deleting it is the only thing that happened to it.
    const removed = mine !== undefined && theirs === undefined && was !== undefined && sameContent(was, mine);
    if (mine !== undefined && !removed) staying.set(fold(name), name);
  }

  for (const { name, mine, theirs, was } of decided) {
    if (mine !== undefined && theirs !== undefined) {
      if (sameContent(mine, theirs)) continue;
      if (was !== undefined && sameContent(was, mine)) {
        writes.push({ kind: 'take', name, file: theirs });
        continue;
      }
      if (was !== undefined && sameContent(was, theirs)) {
        push = true;
        continue;
      }
      const chat = CHARACTER_CHAT.test(name) ? 'character' : GROUP_CHAT.test(name) ? 'group' : null;
      if (chat === null) {
        writes.push({ kind: 'setAside', name, head: theirs, local: mine });
        continue;
      }
      const as = copyName(name, input.copyTag, (candidate) => staying.has(fold(candidate)) || head.has(candidate));
      staying.set(fold(as), as);
      writes.push({ kind: 'keepBoth', name, as, head: theirs, local: mine, chat, mayExtend: extending(mine, theirs) });
      push = true;
      continue;
    }

    if (mine !== undefined) {
      // Only here. Unchanged since the base means another device deleted it;
      // anything else is this device's own work, and a change beats a delete.
      if (was !== undefined && sameContent(was, mine)) removals.push({ kind: 'remove', name });
      else push = true;
      continue;
    }

    if (theirs === undefined) continue;
    // Only in the head. If it is what the base had, this device deleted it and
    // nobody else touched it, so it stays deleted and the deletion goes up.
    if (was !== undefined && sameContent(was, theirs)) {
      push = true;
      continue;
    }
    const reason = refusal(name, input.windowsNames) ?? (clashes(name, staying, fold) ? 'case_collision' : null);
    if (reason !== null) {
      skipped.push({ name, reason });
      carried.push(theirs);
      continue;
    }
    staying.set(fold(name), name);
    writes.push({ kind: 'take', name, file: theirs });
  }

  return { actions: [...removals, ...writes], carried, skipped, push };
}

/** Whether two entries hold the same bytes, whatever their timestamps say. */
export function sameContent(a: HashedFile, b: HashedFile): boolean {
  if (a.sizeBytes !== b.sizeBytes || a.chunks.length !== b.chunks.length) return false;
  return a.chunks.every((chunk, at) => chunk.hash === b.chunks[at]?.hash);
}

function index(files: readonly HashedFile[]): Map<string, HashedFile> {
  return new Map(files.map((file) => [file.name, file]));
}

/** Code-unit order, so a plan reads the same on every device and in every locale. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which side, if either, could be the other one plus more at the end.
 *
 * Every chunk the shorter file filled completely must be in the longer one at
 * the same place. Its last, partly filled chunk has a hash of its own that
 * proves nothing either way.
 */
function extending(mine: HashedFile, theirs: HashedFile): 'local' | 'head' | null {
  if (mine.sizeBytes === theirs.sizeBytes) return null;
  const [shorter, longer, side] = mine.sizeBytes < theirs.sizeBytes ? [mine, theirs, 'head' as const] : [theirs, mine, 'local' as const];
  const settled = Math.floor(shorter.sizeBytes / CHUNK_BYTES);
  for (let at = 0; at < settled; at += 1) {
    if (shorter.chunks[at]?.hash !== longer.chunks[at]?.hash) return null;
  }
  return side;
}

/** Why a name from storage must not be written on this device, if there is a reason. */
function refusal(name: string, windowsNames: boolean): SkipReason | null {
  const segments = name.split('/');
  if (name === '' || name.includes('\u0000') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'unsafe_name';
  if (!windowsNames) return null;
  if (/^[A-Za-z]:/u.test(name)) return 'unsafe_name';
  for (const segment of segments) {
    if (WINDOWS_FORBIDDEN.test(segment) || WINDOWS_RESERVED.test(segment) || /[. ]$/u.test(segment)) return 'invalid_name';
  }
  return null;
}

/** Whether a different file already holds this name as far as this device's file system can tell. */
function clashes(name: string, staying: ReadonlyMap<string, string>, fold: (name: string) => string): boolean {
  const holder = staying.get(fold(name));
  return holder !== undefined && holder !== name;
}

/**
 * The name this device's version of a chat gets when both versions are kept.
 *
 * SillyTavern lists every `.jsonl` in a character's folder as one of its
 * chats, so a second file beside the first is all it takes for both to show
 * up. The tag is cleaned to what every file system accepts, because the copy
 * travels to the other devices too.
 */
function copyName(name: string, copyTag: string, taken: (candidate: string) => boolean): string {
  const slash = name.lastIndexOf('/');
  const folder = name.slice(0, slash + 1);
  const file = name.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const extension = dot > 0 ? file.slice(dot) : '';
  const tag = [...copyTag.normalize('NFC').replace(TAG_FORBIDDEN, ' ').replace(/\s+/gu, ' ').trim()].slice(0, MAX_TAG_CHARS).join('').replace(/[. ]+$/u, '') || 'copy';
  for (let attempt = 1; ; attempt += 1) {
    const suffix = ` (${attempt === 1 ? tag : `${tag} ${String(attempt)}`})${extension}`;
    const candidate = `${folder}${clip(stem, MAX_NAME_BYTES - Buffer.byteLength(suffix, 'utf8'))}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Cut a string to a byte budget without splitting a character. */
function clip(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    out += character;
    bytes += size;
  }
  return out.replace(/[. ]+$/u, '') || 'chat';
}
