import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExtensionInfo, ExtensionUpdate } from '../../../packages/contracts/src/index.js';
import { GitError, mapPooled, runGit, type FoundExtension } from './extensions.js';

/**
 * Updating a third-party extension, and taking an update back.
 *
 * Done with git on the extension's own folder, the way SillyTavern's own
 * "update" does it, but with two things SillyTavern does not keep: the commit
 * an update left, so it can be returned to, and a refusal instead of a lost
 * edit when somebody changed the extension's files by hand.
 *
 * - An update fetches, then moves the branch forward only (`--ff-only`). An
 *   extension whose branch went somewhere this checkout cannot follow is
 *   refused, never reset.
 * - A roll back checks the recorded commit out on its own, off the branch,
 *   and remembers the branch, so the next update goes back onto it.
 * - What a check found is kept in memory for an hour. It is a question asked
 *   of somebody else's server, and asking it on every visit to the page would
 *   be a dozen fetches for an answer that has not changed.
 */

const HISTORY_FILE = 'extensions-history.json';
/** How long a check for updates stays the answer. */
export const CHECK_TTL_MS = 60 * 60 * 1000;
/** A fetch over a slow connection; a clone of a large extension is not this, an update is. */
const FETCH_TIMEOUT_MS = 120_000;
/** How many remotes are asked at once. */
const CHECK_CONCURRENCY = 3;

export class ExtensionError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface HistoryEntry {
  /** The branch to go back onto; kept while a roll back has the checkout off it. */
  readonly branch: string | null;
  /** The commit the last update from here left, until it is rolled back to. */
  readonly previous: { readonly commit: string; readonly at: string } | null;
}

interface PersistedHistory {
  readonly schemaVersion: 1;
  /** By the extension's folder, which is what tells two extensions of one name apart. */
  readonly entries: Readonly<Record<string, HistoryEntry>>;
}

export interface ExtensionUpdaterOptions {
  /** The manager's state directory, where the history file lives. */
  readonly stateDir: string;
  readonly gitCommand?: string;
  readonly now?: () => Date;
}

export class ExtensionUpdater {
  private readonly checks = new Map<string, ExtensionUpdate>();
  private checked: string | null = null;
  private history: PersistedHistory | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly gitCommand: string;
  private readonly now: () => Date;

  public constructor(private readonly options: ExtensionUpdaterOptions) {
    this.gitCommand = options.gitCommand ?? 'git';
    this.now = options.now ?? (() => new Date());
  }

  /** When updates were last looked for, by a check of everything. */
  public get checkedAt(): string | null { return this.checked; }

  /** Whether the last check is old enough to be asked again without being told to. */
  public isStale(): boolean {
    return this.checked === null || this.now().getTime() - Date.parse(this.checked) >= CHECK_TTL_MS;
  }

  /** The list as the panel sees it: what is on disk, with what is known about updates. */
  public async describe(found: readonly FoundExtension[]): Promise<Array<Omit<ExtensionInfo, 'errors'>>> {
    const history = await this.loadHistory();
    return found.map((entry) => {
      const key = keyOf(entry);
      const previous = history.entries[key]?.previous ?? null;
      return {
        ...entry.info,
        update: this.checks.get(key) ?? null,
        canRollBack: previous !== null && entry.info.git !== null && previous.commit !== entry.info.git.commit,
      };
    });
  }

  /** Ask each extension's remote what it has; problems are kept per extension, not thrown. */
  public async check(found: readonly FoundExtension[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const candidates = found.filter((entry) => entry.info.hasGit);
    let done = 0;
    onProgress?.(0, candidates.length);
    await mapPooled(candidates, CHECK_CONCURRENCY, async (entry) => {
      const checkedAt = this.now().toISOString();
      try {
        const tracking = await this.tracking(entry);
        await this.fetch(entry.path, tracking.remote);
        const behind = await this.count(entry.path, `HEAD..${tracking.upstream}`);
        this.checks.set(keyOf(entry), { behind, problem: null, checkedAt });
      } catch (error: unknown) {
        this.checks.set(keyOf(entry), { behind: null, problem: error instanceof ExtensionError ? error.code : 'extension_fetch_failed', checkedAt });
      }
      done += 1;
      onProgress?.(done, candidates.length);
    });
    this.checked = this.now().toISOString();
  }

  /**
   * Move an extension forward to what its remote has.
   *
   * `upToDate` when there was nothing to move to. The commit it was on is
   * written down before anything moves, so a failure halfway still leaves
   * the way back.
   */
  public async update(entry: FoundExtension): Promise<{ readonly outcome: 'updated' | 'upToDate'; readonly from: string; readonly to: string }> {
    const git = entry.info.git;
    if (!git) throw new ExtensionError('extension_git_unreadable', 'This extension has no git checkout that can be read');
    await this.assertClean(entry.path);
    const tracking = await this.tracking(entry);
    await this.fetch(entry.path, tracking.remote);
    const detached = git.branch === null;
    if (!detached && await this.count(entry.path, `${tracking.upstream}..HEAD`) > 0) {
      throw new ExtensionError('extension_diverged', 'This extension has commits its remote does not, so it cannot be moved forward');
    }
    const behind = await this.count(entry.path, `HEAD..${tracking.upstream}`);
    const key = keyOf(entry);
    if (!detached && behind === 0) {
      this.checks.set(key, { behind: 0, problem: null, checkedAt: this.now().toISOString() });
      return { outcome: 'upToDate', from: git.commit, to: git.commit };
    }
    const before = (await this.loadHistory()).entries[key] ?? null;
    await this.record(key, { branch: tracking.branch, previous: { commit: git.commit, at: this.now().toISOString() } });
    let moved = false;
    try {
      if (detached) {
        await runGit(this.gitCommand, entry.path, ['checkout', '--quiet', tracking.branch, '--']);
        moved = true;
      }
      await runGit(this.gitCommand, entry.path, ['merge', '--ff-only', '--quiet', tracking.upstream], FETCH_TIMEOUT_MS);
    } catch (error: unknown) {
      // Nothing moved, so there is nothing to roll back to either.
      if (!moved) await this.record(key, before);
      throw new ExtensionError('extension_update_failed', error instanceof Error ? error.message : 'git could not update the extension');
    }
    const to = (await runGit(this.gitCommand, entry.path, ['rev-parse', 'HEAD'])).trim();
    this.checks.set(key, { behind: 0, problem: null, checkedAt: this.now().toISOString() });
    return { outcome: 'updated', from: git.commit, to };
  }

  /** Go back to the commit the last update from here left. */
  public async rollBack(entry: FoundExtension): Promise<{ readonly from: string; readonly to: string }> {
    const git = entry.info.git;
    const key = keyOf(entry);
    const recorded = (await this.loadHistory()).entries[key] ?? null;
    if (!git || !recorded?.previous || recorded.previous.commit === git.commit) {
      throw new ExtensionError('extension_no_rollback', 'There is no earlier version of this extension recorded to go back to');
    }
    await this.assertClean(entry.path);
    try {
      await runGit(this.gitCommand, entry.path, ['checkout', '--quiet', '--detach', recorded.previous.commit, '--']);
    } catch (error: unknown) {
      throw new ExtensionError('extension_rollback_failed', error instanceof Error ? error.message : 'git could not go back');
    }
    await this.record(key, { branch: recorded.branch ?? git.branch, previous: null });
    // Said without asking the remote: what the branch has is already here.
    const branch = recorded.branch ?? git.branch;
    const behind = branch ? await this.count(entry.path, `HEAD..${branch}@{upstream}`).catch(() => null) : null;
    this.checks.set(key, { behind, problem: null, checkedAt: this.now().toISOString() });
    return { from: git.commit, to: recorded.previous.commit };
  }

  /** The branch an extension follows and where that branch comes from. */
  private async tracking(entry: FoundExtension): Promise<{ branch: string; upstream: string; remote: string }> {
    if (!entry.info.git) throw new ExtensionError('extension_git_unreadable', 'This extension has no git checkout that can be read');
    const branch = entry.info.git.branch ?? (await this.loadHistory()).entries[keyOf(entry)]?.branch ?? null;
    if (!branch) throw new ExtensionError('extension_no_branch', 'This extension is not on a branch, so there is nothing to follow');
    try {
      const upstream = (await runGit(this.gitCommand, entry.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])).trim();
      const remote = (await runGit(this.gitCommand, entry.path, ['config', '--get', `branch.${branch}.remote`])).trim();
      if (!upstream || !remote) throw new Error('no upstream');
      return { branch, upstream, remote };
    } catch {
      throw new ExtensionError('extension_no_upstream', 'This extension’s branch does not follow a remote branch');
    }
  }

  private async fetch(directory: string, remote: string): Promise<void> {
    try {
      await runGit(this.gitCommand, directory, ['fetch', '--quiet', '--no-tags', remote], FETCH_TIMEOUT_MS);
    } catch (error: unknown) {
      throw new ExtensionError('extension_fetch_failed', error instanceof GitError ? error.message : 'The extension’s remote could not be reached');
    }
  }

  private async count(directory: string, range: string): Promise<number> {
    const value = Number((await runGit(this.gitCommand, directory, ['rev-list', '--count', range])).trim());
    if (!Number.isInteger(value) || value < 0) throw new ExtensionError('extension_git_unreadable', 'git gave an answer that is not a count');
    return value;
  }

  /** Edits to tracked files are somebody's work; an update must never be what loses them. */
  private async assertClean(directory: string): Promise<void> {
    const status = await runGit(this.gitCommand, directory, ['status', '--porcelain', '--untracked-files=no']).catch(() => {
      throw new ExtensionError('extension_git_unreadable', 'git could not read this extension’s files');
    });
    if (status.trim()) throw new ExtensionError('extension_local_changes', 'This extension’s files were changed by hand, so it is left as it is');
  }

  private async loadHistory(): Promise<PersistedHistory> {
    if (this.history) return this.history;
    try {
      const parsed = JSON.parse(await readFile(join(this.options.stateDir, HISTORY_FILE), 'utf8')) as unknown;
      this.history = isHistory(parsed) ? parsed : emptyHistory();
    } catch { this.history = emptyHistory(); }
    return this.history;
  }

  private async record(key: string, entry: HistoryEntry | null): Promise<void> {
    const history = await this.loadHistory();
    const entries = { ...history.entries };
    if (entry) entries[key] = entry; else delete entries[key];
    this.history = { schemaVersion: 1, entries };
    const snapshot = this.history;
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.options.stateDir, { recursive: true });
      const target = join(this.options.stateDir, HISTORY_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    });
    await this.writing;
  }
}

function keyOf(entry: FoundExtension): string {
  return resolve(entry.path);
}

function emptyHistory(): PersistedHistory {
  return { schemaVersion: 1, entries: {} };
}

function isHistory(value: unknown): value is PersistedHistory {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.entries !== 'object' || record.entries === null) return false;
  return Object.values(record.entries as Record<string, unknown>).every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { branch, previous } = entry as Record<string, unknown>;
    if (branch !== null && typeof branch !== 'string') return false;
    if (previous === null) return true;
    return typeof previous === 'object' && typeof (previous as Record<string, unknown>).commit === 'string' && typeof (previous as Record<string, unknown>).at === 'string';
  });
}
