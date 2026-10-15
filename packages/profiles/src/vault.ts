import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, statfs, utimes, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import { logEvent, logLineText, type LogSink } from '../../contracts/src/index.js';
import { archiveFormat, packTree, unpackTree, type ArchiveFormat } from '../../platform/src/archive.js';
import { ioConcurrency, runPooled } from '../../platform/src/index.js';
import { removeTreeGently } from '../../platform/src/remove.js';

/**
 * The profiles' data, worked on from this machine's disk and kept on network
 * storage as one pack plus a journal.
 *
 * A profile is thousands of small files and SillyTavern reads most of them
 * every time it is opened. On network storage each of those reads is a round
 * trip, and opening a large profile took minutes; restoring a backup into it,
 * one file at a time, took longer. Here the profiles live on the local disk,
 * where all of that is instant, and the data directory holds:
 *
 * - a base: every profile as one compressed tar, written now and then;
 * - a journal: after that, every few seconds, the files that changed, as one
 *   small tar per batch, with the paths that were deleted;
 * - a head naming the base and the journal in order, replaced in one rename;
 * - at most two packs kept from before a base that lost most of the data.
 *
 * A machine that comes back with an empty disk unpacks the base and replays
 * the journal: one large read at the network's full speed instead of
 * thousands of small ones. What is lost if the machine dies outright is what
 * changed in the last few seconds.
 */

const HEAD_FILE = 'head.json';
const DEFAULT_INTERVAL_MS = 5_000;
/** A batch this large is cheaper written as a new base than as a journal entry. */
const REBASE_CHANGED_SHARE = 0.5;
const REBASE_CHANGED_FILES = 3_000;
/** When the journal has grown this much, the next quiet moment folds it into a new base. */
const MAX_JOURNAL_ENTRIES = 200;
const MIN_JOURNAL_BYTES_BEFORE_REBASE = 64 * 1024 * 1024;
const JOURNAL_SHARE_BEFORE_REBASE = 0.25;
/**
 * A new base with less than this share of an earlier one's files or bytes has
 * lost most of the data, and the earlier one is kept rather than removed.
 */
const SHRINK_SHARE = 0.5;
const MAX_KEPT = 2;
/** Room asked for beyond the profiles themselves: SillyTavern writes caches and thumbnails as it runs. */
const ROOM_MARGIN = 0.1;
const ROOM_FLOOR_BYTES = 256 * 1024 * 1024;
/** A pack written before the unpacked size was recorded is taken to unpack to about this many times its size. */
const UNPACKED_PER_PACKED = 2;

interface Stamp { readonly size: number; readonly mtimeMs: number }

interface PackedFile {
  readonly file: string;
  readonly format: ArchiveFormat;
  readonly bytes: number;
}

interface JournalEntry extends PackedFile {
  readonly seq: number;
  readonly files: number;
  /** Paths deleted since the entry before, relative to the root, with forward slashes. */
  readonly deleted: readonly string[];
}

interface BaseEntry extends PackedFile {
  readonly files: number;
  /** The bytes of the files it holds, before compression; absent on a base written before it was recorded. */
  readonly sourceBytes?: number;
  readonly createdAt: string;
}

interface Head {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly base: BaseEntry | null;
  readonly journal: readonly JournalEntry[];
  /**
   * Earlier bases set aside because a later one held much less: an emptied or
   * half-wiped working copy otherwise replaces the only pack with the data a
   * few seconds later. They are never unpacked on their own, and go once the
   * profiles are about as large as they were again.
   */
  readonly kept?: readonly BaseEntry[];
}

interface SavedState {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly files: Record<string, [number, number]>;
}

export interface ProfileVaultOptions {
  /** The working copy on this machine's disk. */
  readonly local: string;
  /** Where the base, the journal and the head are kept, on the data directory. */
  readonly durable: string;
  /** The data directory's own tree of profiles from before, taken in once. */
  readonly legacy?: string;
  readonly logger?: LogSink;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /** Free bytes on the disk holding `path`, or null when that cannot be told. */
  readonly freeBytes?: (path: string) => Promise<number | null>;
}

export class ProfileVault {
  readonly local: string;
  readonly durable: string;
  private readonly legacy: string | null;
  private readonly logger: LogSink;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly freeBytes: (path: string) => Promise<number | null>;
  private head: Head | null = null;
  private known = new Map<string, Stamp>();
  private queue: Promise<void> = Promise.resolve();
  private cleanup: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private restored = false;
  private rebaseSoon = false;

  public constructor(options: ProfileVaultOptions) {
    this.local = options.local;
    this.durable = options.durable;
    this.legacy = options.legacy ?? null;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.freeBytes = options.freeBytes ?? diskFreeBytes;
  }

  /** Where the last flushed view of the working copy is kept, beside it rather than in it. */
  private get statePath(): string { return `${this.local}.vault-state.json`; }

  /**
   * Fill the working copy before anything reads it.
   *
   * A working copy that is already there - the manager restarted, the machine
   * did not - is newer than anything written out, and is kept. Otherwise it
   * comes from the pack and the journal, or once, from the tree the data
   * directory held before there was a vault.
   */
  public async restore(): Promise<void> {
    const started = Date.now();
    await mkdir(this.local, { recursive: true });
    this.head = await this.readHead();
    const present = await scan(this.local);
    if (present.size > 0) {
      const saved = await this.readState();
      // The last view written out matches the pack, so only what changed
      // since is still to be sent; without one, everything is sent again.
      this.known = saved && saved.seq === (this.head?.seq ?? 0) ? new Map(Object.entries(saved.files).map(([path, [size, mtimeMs]]) => [path, { size, mtimeMs }])) : new Map();
      this.restored = true;
      this.logger(logEvent('vault.kept', `[vault] kept the ${present.size} profile files already on this machine's disk`, { files: present.size }));
      return;
    }
    if (this.head) {
      const head = this.head;
      const packed = [...(head.base ? [head.base] : []), ...head.journal];
      await this.ensureRoom(packed.reduce((sum, entry) => sum + ('sourceBytes' in entry && typeof entry.sourceBytes === 'number' ? entry.sourceBytes : entry.bytes * UNPACKED_PER_PACKED), 0));
      const unpack = async (packed: PackedFile): Promise<void> => {
        try { await unpackTree(join(this.durable, packed.file), packed.format, this.local); }
        catch (error: unknown) { throw new Error(`${packed.file} could not be unpacked: ${reason(error)}`); }
      };
      if (this.head.base) await unpack(this.head.base);
      for (const entry of this.head.journal) {
        await unpack(entry);
        for (const path of entry.deleted) await rm(join(this.local, ...safeSegments(path)), { force: true });
      }
      this.known = await scan(this.local);
      await this.writeState();
      this.restored = true;
      this.logger(logEvent('vault.restored', `[vault] put ${this.known.size} profile files back on this machine's disk in ${seconds(started)}s`, { files: this.known.size, seconds: seconds(started) }));
      return;
    }
    const legacyFiles = this.legacy ? await scan(this.legacy) : new Map<string, Stamp>();
    if (this.legacy && legacyFiles.size > 0) {
      const legacyRoot = this.legacy;
      await this.ensureRoom([...legacyFiles.values()].reduce((sum, stamp) => sum + stamp.size, 0));
      const files = [...legacyFiles.keys()];
      const directories = new Set(files.map((file) => posix.dirname(file)));
      for (const directory of directories) await mkdir(join(this.local, ...safeSegments(directory)), { recursive: true });
      await runPooled(files, ioConcurrency() * 2, async (file) => {
        const target = join(this.local, ...safeSegments(file));
        await copyFile(join(legacyRoot, ...safeSegments(file)), target);
        // SillyTavern orders chats and characters by when their files last
        // changed, and a copy is new unless it is told otherwise.
        const stamp = legacyFiles.get(file)!;
        await utimes(target, new Date(stamp.mtimeMs), new Date(stamp.mtimeMs));
      });
      this.restored = true;
      const current = await scan(this.local);
      await this.rebase(current);
      this.logger(logEvent('vault.adopted', `[vault] moved ${files.length} profile files from the data directory onto this machine's disk in ${seconds(started)}s`, { files: files.length, seconds: seconds(started) }));
      const legacy = this.legacy;
      this.cleanup = this.cleanup.then(async () => {
        await removeTreeGently(legacy);
        this.logger(logEvent('vault.legacyRemoved', '[vault] removed the old file-by-file copy of the profiles from the data directory'));
      }).catch((error: unknown) => this.logger(`[vault] the old copy of the profiles could not be removed: ${reason(error)}`));
      return;
    }
    this.restored = true;
  }

  /**
   * Fail before filling the working copy when this disk cannot hold it.
   *
   * Halfway through, a full disk fails the same way, but leaves a part-filled
   * working copy and a machine with no room for SillyTavern to write in. The
   * data directory's copy is untouched either way.
   */
  private async ensureRoom(bytes: number): Promise<void> {
    const free = await this.freeBytes(this.local).catch(() => null);
    if (free === null) return;
    const needed = Math.ceil(bytes * (1 + ROOM_MARGIN)) + ROOM_FLOOR_BYTES;
    if (free < needed) throw new Error(`the disk holding ${this.local} has ${gigabytes(free)} free and the profiles need about ${gigabytes(needed)}`);
  }

  /** Write out what changed every few seconds, from now on. */
  public start(): void {
    if (this.timer || !this.restored) return;
    this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, this.intervalMs);
    this.timer.unref();
  }

  /**
   * Write out what changed since the last time, now.
   *
   * Never before the working copy has been filled: an empty working copy
   * written out would stand in for the real data.
   */
  public async flush(): Promise<void> {
    if (!this.restored) return;
    const run = async (): Promise<void> => {
      try {
        await this.flushOnce();
      } catch (error: unknown) {
        this.logger(logEvent('vault.flushFailed', `[vault] changes to the profiles could not be written to the data directory yet: ${reason(error)}`, { reason: reason(error) }));
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    await next;
  }

  private async flushOnce(): Promise<void> {
    const current = await scan(this.local);
    const changed: string[] = [];
    let changedBytes = 0;
    let totalBytes = 0;
    for (const [path, stamp] of current) {
      totalBytes += stamp.size;
      const before = this.known.get(path);
      if (!before || before.size !== stamp.size || before.mtimeMs !== stamp.mtimeMs) { changed.push(path); changedBytes += stamp.size; }
    }
    const deleted = [...this.known.keys()].filter((path) => !current.has(path));
    if (changed.length === 0 && deleted.length === 0) {
      if (this.rebaseSoon) await this.rebase(current);
      return;
    }
    const big = changedBytes > totalBytes * REBASE_CHANGED_SHARE || changed.length > REBASE_CHANGED_FILES;
    // An emptied working copy is not written over a base that holds data: the
    // deletions go in the journal, where they can still be seen and undone.
    const emptyOverFull = current.size === 0 && (this.head?.base?.files ?? 0) > 0;
    if ((!this.head?.base || big) && !emptyOverFull) {
      await this.rebase(current);
      return;
    }
    await this.appendJournal(changed, deleted, current);
  }

  private async appendJournal(changed: readonly string[], deleted: readonly string[], current: Map<string, Stamp>): Promise<void> {
    const head = this.head ?? { schemaVersion: 1 as const, seq: 0, base: null, journal: [] };
    const seq = head.seq + 1;
    const format = archiveFormat();
    const file = `journal-${String(seq).padStart(8, '0')}-${randomBytes(4).toString('hex')}.tar.${format}`;
    await mkdir(this.durable, { recursive: true });
    let files = changed;
    let bytes: number;
    try {
      bytes = await packTree(this.local, join(this.durable, file), format, files);
    } catch {
      // Deleted between the look and the pack. Look again, once.
      const again = await scan(this.local);
      files = changed.filter((path) => again.has(path));
      for (const path of changed) if (!again.has(path)) current.delete(path);
      bytes = await packTree(this.local, join(this.durable, file), format, files);
    }
    const entry: JournalEntry = { file, format, bytes, seq, files: files.length, deleted: [...deleted] };
    await this.writeHead({ ...head, seq, journal: [...head.journal, entry] });
    this.known = current;
    await this.writeState();
    const journalBytes = this.head!.journal.reduce((sum, item) => sum + item.bytes, 0);
    const baseBytes = this.head!.base?.bytes ?? 0;
    if (this.head!.journal.length >= MAX_JOURNAL_ENTRIES || journalBytes > Math.max(MIN_JOURNAL_BYTES_BEFORE_REBASE, baseBytes * JOURNAL_SHARE_BEFORE_REBASE)) this.rebaseSoon = true;
  }

  /** Write every profile as a new base, and let the journal go. */
  private async rebase(current: Map<string, Stamp>): Promise<void> {
    const started = Date.now();
    const previous = this.head;
    const seq = (previous?.seq ?? 0) + 1;
    const format = archiveFormat();
    const file = `base-${String(seq).padStart(8, '0')}-${randomBytes(4).toString('hex')}.tar.${format}`;
    await mkdir(this.durable, { recursive: true });
    let bytes = 0;
    let failure: unknown;
    // SillyTavern goes on writing while this packs; a file it deletes under
    // the packer fails the pack, and the next attempt does not meet it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { bytes = await packTree(this.local, join(this.durable, file), format); failure = undefined; break; }
      catch (error: unknown) { failure = error; }
    }
    if (failure !== undefined) throw failure;
    const sourceBytes = [...current.values()].reduce((sum, stamp) => sum + stamp.size, 0);
    const base: BaseEntry = { file, format, bytes, files: current.size, sourceBytes, createdAt: this.now().toISOString() };
    const shrunk = (earlier: BaseEntry): boolean => base.files < earlier.files * SHRINK_SHARE || (earlier.sourceBytes !== undefined && sourceBytes < earlier.sourceBytes * SHRINK_SHARE);
    const earlier = previous?.kept ?? [];
    const setAside = previous?.base && shrunk(previous.base) ? previous.base : null;
    // Of more than can be kept, the one with the fewest files goes first.
    const kept = [...earlier, ...(setAside ? [setAside] : [])].filter(shrunk).sort((left, right) => right.files - left.files).slice(0, MAX_KEPT);
    await this.writeHead({ schemaVersion: 1, seq, base, journal: [], ...(kept.length > 0 ? { kept } : {}) });
    this.known = current;
    this.rebaseSoon = false;
    await this.writeState();
    const keptNames = new Set(kept.map((entry) => entry.file));
    if (previous) {
      const stale = [previous.base?.file, ...previous.journal.map((entry) => entry.file), ...earlier.map((entry) => entry.file)].filter((name): name is string => name !== undefined && !keptNames.has(name));
      await Promise.all(stale.map((name) => rm(join(this.durable, name), { force: true })));
    }
    if (setAside && keptNames.has(setAside.file)) {
      this.logger(logEvent('vault.keptEarlier', `[vault] the profiles now hold ${current.size} files where the last pack held ${setAside.files}, so that pack is kept as ${join(this.durable, setAside.file)} and not removed; it is not put back on its own`, { files: current.size, earlier: setAside.files, path: join(this.durable, setAside.file) }));
    }
    for (const entry of earlier) {
      if (!keptNames.has(entry.file)) this.logger(logEvent('vault.keptReleased', `[vault] removed the pack of ${entry.files} files kept from before, ${entry.file}`, { files: entry.files, file: entry.file }));
    }
    this.logger(logEvent('vault.packed', `[vault] wrote all ${current.size} profile files to the data directory as one pack (${megabytes(bytes)}) in ${seconds(started)}s`, { files: current.size, size: megabytes(bytes), seconds: seconds(started) }));
  }

  /**
   * Forget everything, here and in the data directory, and start again empty.
   * For a reset: what it erases must not be written back a few seconds later.
   */
  public async erase(): Promise<void> {
    const run = async (): Promise<void> => {
      await rm(this.local, { recursive: true, force: true });
      await mkdir(this.local, { recursive: true });
      await rm(this.durable, { recursive: true, force: true });
      await rm(this.statePath, { force: true });
      this.head = null;
      this.known = new Map();
      this.rebaseSoon = false;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    await next;
  }

  /** Stop, after writing out what is still unwritten. */
  public async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush().catch(() => undefined);
    await this.cleanup;
  }

  /** Resolves once the work queued so far is done. */
  public async settled(): Promise<void> {
    await this.queue;
    await this.cleanup;
  }

  private async readHead(): Promise<Head | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(join(this.durable, HEAD_FILE), 'utf8')); } catch { return null; }
    if (!isHead(parsed)) throw new Error('the profile vault head in the data directory cannot be read');
    return parsed;
  }

  private async writeHead(head: Head): Promise<void> {
    const target = join(this.durable, HEAD_FILE);
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(head)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    this.head = head;
  }

  private async readState(): Promise<SavedState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<SavedState>;
      return parsed.schemaVersion === 1 && typeof parsed.seq === 'number' && typeof parsed.files === 'object' && parsed.files !== null ? parsed as SavedState : null;
    } catch { return null; }
  }

  private async writeState(): Promise<void> {
    const files: Record<string, [number, number]> = {};
    for (const [path, stamp] of this.known) files[path] = [stamp.size, stamp.mtimeMs];
    const state: SavedState = { schemaVersion: 1, seq: this.head?.seq ?? 0, files };
    const temporary = `${this.statePath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

/** Every regular file under `root`, by its path relative to it with forward slashes. */
async function scan(root: string): Promise<Map<string, Stamp>> {
  const found = new Map<string, Stamp>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        try {
          const details = await lstat(absolute);
          found.set(relative, { size: details.size, mtimeMs: Math.trunc(details.mtimeMs) });
        } catch { /* gone since the listing */ }
      }
    }
  };
  await walk(root, '');
  return found;
}

/** A relative path from the journal as path segments, refusing any that would climb out. */
function safeSegments(path: string): string[] {
  if (path === '.') return [];
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) throw new Error(`refusing the journal path ${path}`);
  return segments;
}

function isHead(value: unknown): value is Head {
  if (typeof value !== 'object' || value === null) return false;
  const head = value as Partial<Head>;
  return head.schemaVersion === 1 && typeof head.seq === 'number' && Array.isArray(head.journal) && (head.base === null || typeof head.base === 'object') && (head.kept === undefined || Array.isArray(head.kept));
}

function seconds(started: number): string {
  return ((Date.now() - started) / 1000).toFixed(1);
}

async function diskFreeBytes(path: string): Promise<number | null> {
  try {
    const details = await statfs(path);
    return details.bavail * details.bsize;
  } catch {
    return null;
  }
}

function gigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
