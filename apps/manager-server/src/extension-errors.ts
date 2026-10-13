import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionErrorEntry, ExtensionErrorKind, ExtensionErrorSummary, Installation } from '../../../packages/contracts/src/index.js';

/**
 * Which extension broke, told by the browser and by SillyTavern's own log.
 *
 * A third-party extension runs in the reader's browser, so when one throws
 * the manager never hears of it: the server log stays clean and SillyTavern
 * simply looks broken. The door's script listens for errors on SillyTavern's
 * page and passes on the ones whose file is an extension's; server plugins
 * fail in SillyTavern's own output, which the manager already reads.
 *
 * Kept small and kept here: the last twenty different errors of each, with
 * the version of SillyTavern they were seen on, and never anything but the
 * error's own first few hundred characters.
 */

const STATE_FILE = 'extension-errors.json';
const KEPT_PER_EXTENSION = 20;
/** How long after a version change a first error still counts as that change's doing. */
export const BROKE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 300;
const FILE_LIMIT = 300;
/** Per extension and overall, per minute: a loop that throws must not become a disk that fills. */
const RATE_PER_NAME = 30;
const RATE_TOTAL = 200;

export interface ExtensionErrorReport {
  readonly name: string;
  readonly message: string;
  readonly file: string | null;
  readonly line: number | null;
}

/** A version change, as the installations say it happened. */
export interface VersionChange {
  readonly version: string;
  readonly previous: string;
  readonly at: string;
}

/**
 * The report a page sent, or null when it is not one.
 *
 * The name is a folder name as SillyTavern's own URL carries it; anything with
 * a separator or that is only dots names no folder and is dropped.
 */
export function parseErrorReport(body: unknown): ExtensionErrorReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!isExtensionName(name)) return null;
  const message = typeof record.message === 'string' ? clean(record.message, MESSAGE_LIMIT) : '';
  if (!message) return null;
  const file = typeof record.file === 'string' && record.file ? clean(record.file, FILE_LIMIT) : null;
  const line = typeof record.line === 'number' && Number.isInteger(record.line) && record.line >= 0 && record.line < 10_000_000 ? record.line : null;
  return { name, message, file, line };
}

export function isExtensionName(value: string): boolean {
  return value.length > 0 && value.length <= 100 && !/[/\\\u0000-\u001f]/u.test(value) && !/^\.+$/u.test(value);
}

/**
 * A server plugin that failed to load, from a line of SillyTavern's output.
 *
 * SillyTavern says `Failed to load plugin from <path>: <error>`; the plugin
 * is the folder under `plugins/` in that path.
 */
export function pluginFailure(line: string): ExtensionErrorReport | null {
  const match = /Failed to load plugin from (.+?):\s(.+)$/u.exec(line);
  if (!match) return null;
  const folder = /[/\\]plugins[/\\]([^/\\]+)/u.exec(match[1] ?? '')?.[1] ?? '';
  if (!isExtensionName(folder)) return null;
  return { name: folder, message: clean(match[2] ?? '', MESSAGE_LIMIT), file: null, line: null };
}

/**
 * The last switch of SillyTavern's version, if the active installation came
 * after another one.
 *
 * A first install is not a change, and neither is installing the same
 * release again.
 */
export function lastVersionChange(installations: readonly Installation[], active: Installation | null): VersionChange | null {
  if (!active?.activatedAt) return null;
  const activatedAt = active.activatedAt;
  const previous = installations
    .filter((installation) => installation.id !== active.id && installation.activatedAt !== null && installation.activatedAt < activatedAt)
    .sort((left, right) => (right.activatedAt ?? '').localeCompare(left.activatedAt ?? ''))[0];
  if (!previous || previous.resolvedRef === active.resolvedRef) return null;
  return { version: active.resolvedRef, previous: previous.resolvedRef, at: activatedAt };
}

/**
 * Whether an extension's trouble started with the last version change.
 *
 * Its very first error has to be after the change and within a day of it.
 * One that was already failing before is failing on its own account.
 */
export function brokeAfter(firstSeen: string, change: VersionChange | null): string | null {
  if (!change) return null;
  const first = Date.parse(firstSeen);
  const at = Date.parse(change.at);
  return first >= at && first - at <= BROKE_WINDOW_MS ? change.version : null;
}

interface Kept {
  /** The first error ever seen from it, which no trimming of the list forgets. */
  readonly firstSeen: string;
  readonly errors: readonly ExtensionErrorEntry[];
}

interface PersistedErrors {
  readonly schemaVersion: 1;
  readonly entries: Readonly<Record<string, Kept>>;
}

export interface ExtensionErrorStoreOptions {
  readonly stateDir: string;
  readonly now?: () => Date;
}

export class ExtensionErrorStore {
  private state: PersistedErrors | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly window = new Map<string, number[]>();
  private readonly now: () => Date;

  public constructor(private readonly options: ExtensionErrorStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Keep one error. False when it was dropped for coming too fast.
   *
   * The same message from the same place is one entry seen several times,
   * not several entries: a handler that throws on every message would
   * otherwise push everything else out of the list.
   */
  public async record(kind: ExtensionErrorKind, report: ExtensionErrorReport, version: string | null): Promise<boolean> {
    if (!this.allow(`${kind}:${report.name}`)) return false;
    const state = await this.load();
    const key = keyOf(kind, report.name);
    const at = this.now().toISOString();
    const kept = state.entries[key] ?? { firstSeen: at, errors: [] };
    const same = kept.errors.findIndex((entry) => entry.message === report.message && entry.file === report.file && entry.line === report.line && entry.version === version);
    const errors = [...kept.errors];
    if (same >= 0) {
      const entry = errors[same]!;
      errors.splice(same, 1);
      errors.unshift({ ...entry, lastSeen: at, count: entry.count + 1 });
    } else {
      errors.unshift({ message: report.message, file: report.file, line: report.line, version, firstSeen: at, lastSeen: at, count: 1 });
    }
    await this.save({ schemaVersion: 1, entries: { ...state.entries, [key]: { firstSeen: kept.firstSeen, errors: errors.slice(0, KEPT_PER_EXTENSION) } } });
    return true;
  }

  public async summary(kind: ExtensionErrorKind, name: string, change: VersionChange | null): Promise<ExtensionErrorSummary | null> {
    const kept = (await this.load()).entries[keyOf(kind, name)];
    const latest = kept?.errors[0];
    if (!kept || !latest) return null;
    return {
      count: kept.errors.reduce((sum, entry) => sum + entry.count, 0),
      lastAt: latest.lastSeen,
      lastMessage: latest.message,
      brokeAfter: brokeAfter(kept.firstSeen, change),
    };
  }

  /** Every name with errors of one kind, for the server plugins nobody lists otherwise. */
  public async names(kind: ExtensionErrorKind): Promise<string[]> {
    const prefix = `${kind}:`;
    return Object.keys((await this.load()).entries).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  public async errors(kind: ExtensionErrorKind, name: string): Promise<readonly ExtensionErrorEntry[]> {
    return (await this.load()).entries[keyOf(kind, name)]?.errors ?? [];
  }

  /** Forget an extension's errors, for somebody who has dealt with them. */
  public async clear(kind: ExtensionErrorKind, name: string): Promise<void> {
    const state = await this.load();
    const entries = { ...state.entries };
    delete entries[keyOf(kind, name)];
    await this.save({ schemaVersion: 1, entries });
  }

  private allow(key: string): boolean {
    const now = this.now().getTime();
    const recent = (this.window.get(key) ?? []).filter((at) => now - at < 60_000);
    const total = [...this.window.values()].reduce((sum, times) => sum + times.filter((at) => now - at < 60_000).length, 0);
    if (recent.length >= RATE_PER_NAME || total >= RATE_TOTAL) { this.window.set(key, recent); return false; }
    recent.push(now);
    this.window.set(key, recent);
    return true;
  }

  private async load(): Promise<PersistedErrors> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(join(this.options.stateDir, STATE_FILE), 'utf8')) as unknown;
      this.state = isPersisted(parsed) ? parsed : { schemaVersion: 1, entries: {} };
    } catch { this.state = { schemaVersion: 1, entries: {} }; }
    return this.state;
  }

  private async save(next: PersistedErrors): Promise<void> {
    this.state = next;
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.options.stateDir, { recursive: true });
      const target = join(this.options.stateDir, STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    });
    await this.writing;
  }
}

function keyOf(kind: ExtensionErrorKind, name: string): string {
  return `${kind}:${name}`;
}

/** One line of text, at most `limit` characters, with no control characters. */
function clean(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, limit);
}

function isPersisted(value: unknown): value is PersistedErrors {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.entries !== 'object' || record.entries === null) return false;
  return Object.values(record.entries as Record<string, unknown>).every((kept) => typeof kept === 'object' && kept !== null
    && typeof (kept as Record<string, unknown>).firstSeen === 'string' && Array.isArray((kept as Record<string, unknown>).errors));
}

/**
 * One bell notification per version change, naming every extension it broke.
 *
 * Extensions break as the pages that load them are opened, a few seconds or
 * minutes apart. The first is held for a minute so the ones right behind it
 * are named in the same notification; the bell's own dedupe makes it the only
 * one for that version.
 */
export class BrokenAnnouncer {
  private readonly waiting = new Map<string, Set<string>>();

  public constructor(private readonly announce: (version: string, names: readonly string[]) => void, private readonly delayMs = 60_000) {}

  public add(version: string, name: string): void {
    const names = this.waiting.get(version);
    if (names) { names.add(name); return; }
    this.waiting.set(version, new Set([name]));
    const timer = setTimeout(() => {
      const gathered = [...(this.waiting.get(version) ?? [])].sort();
      this.waiting.delete(version);
      this.announce(version, gathered);
    }, this.delayMs);
    timer.unref?.();
  }
}
