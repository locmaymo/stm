import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessState, VersionSwitch } from '../../../packages/contracts/src/index.js';

/**
 * The first minutes of a new SillyTavern version, and the way back from it.
 *
 * Before a switch the new version is started once on an empty data folder,
 * which proves it runs - not that it runs with the reader's own data, their
 * extensions and their server plugins. So the real start is watched too: if
 * the new version will not come up, or falls over while it is still starting
 * out, the previous version goes back and SillyTavern is started on it.
 *
 * The data goes back too, from the copy taken before the switch, only when
 * nothing could have been written since: SillyTavern never came up, or came
 * up and was never sent anything that changes data. Otherwise the copy is
 * offered, never applied on its own - it would take back whatever was
 * written in between.
 */

const STATE_FILE = 'version-switch.json';
/** How long a new version is watched after it first starts. */
export const PROBATION_MS = 5 * 60 * 1000;
const POLL_MS = 2_000;

export interface ProbationResult {
  /** `healthy` when it came up and stayed up; `failed` when it did not. */
  readonly outcome: 'healthy' | 'failed';
  /** Whether anything that writes data reached it before it failed. */
  readonly served: boolean;
  /** What went wrong, in SillyTavern's or the manager's own words. */
  readonly reason: string | null;
}

export interface ProbationWatch {
  readonly start: () => Promise<ProcessState>;
  readonly state: () => ProcessState;
  /** Whether a request that can change data went through the door at or after this time. */
  readonly servedSince: (at: number) => boolean;
  readonly windowMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  /** Ends the watch early, as healthy: the manager is going away and cannot act on it. */
  readonly signal?: AbortSignal;
}

/**
 * Start the new version and watch it.
 *
 * Healthy as soon as somebody stops it or the window passes with it up; a
 * stop is somebody's decision about it, not its failure.
 */
export async function watchProbation(watch: ProbationWatch): Promise<ProbationResult> {
  const now = watch.now ?? Date.now;
  const startedAt = now();
  const first = await watch.start().catch((error: unknown) => ({ status: 'error', error: error instanceof Error ? error.message : 'SillyTavern did not start' }) as ProcessState);
  if (first.status !== 'running') return { outcome: 'failed', served: watch.servedSince(startedAt), reason: first.error ?? 'SillyTavern did not start' };
  const until = startedAt + (watch.windowMs ?? PROBATION_MS);
  while (now() < until && !watch.signal?.aborted) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, watch.pollMs ?? POLL_MS));
    const state = watch.state();
    if (state.status === 'error') return { outcome: 'failed', served: watch.servedSince(startedAt), reason: state.error ?? 'SillyTavern stopped' };
    if (state.status !== 'running') break;
  }
  return { outcome: 'healthy', served: watch.servedSince(startedAt), reason: null };
}

/**
 * The last switch of version, kept across restarts.
 *
 * What the overview reads to offer the way back, and what a manager that
 * restarts mid-probation would otherwise forget.
 */
export class VersionSwitchStore {
  private current: VersionSwitch | null | undefined;
  private writing: Promise<void> = Promise.resolve();

  public constructor(private readonly stateDir: string) {}

  public async get(): Promise<VersionSwitch | null> {
    if (this.current !== undefined) return this.current;
    try {
      const parsed = JSON.parse(await readFile(join(this.stateDir, STATE_FILE), 'utf8')) as unknown;
      this.current = isVersionSwitch(parsed) ? parsed : null;
    } catch { this.current = null; }
    return this.current;
  }

  public async set(next: VersionSwitch): Promise<VersionSwitch> {
    this.current = next;
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      const target = join(this.stateDir, STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    });
    await this.writing;
    return next;
  }

  /** Change the record of the switch that is current, if there is one. */
  public async update(change: Partial<Pick<VersionSwitch, 'outcome' | 'dismissed' | 'reason'>>): Promise<VersionSwitch | null> {
    const current = await this.get();
    return current ? this.set({ ...current, ...change }) : null;
  }
}

function isVersionSwitch(value: unknown): value is VersionSwitch {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.installationId === 'string' && typeof record.ref === 'string'
    && typeof record.previousInstallationId === 'string' && typeof record.previousRef === 'string'
    && typeof record.at === 'string' && (record.safetyCopyId === null || typeof record.safetyCopyId === 'string')
    && (record.profileId === null || typeof record.profileId === 'string')
    && (record.outcome === 'probation' || record.outcome === 'kept' || record.outcome === 'rolledBack' || record.outcome === 'rollbackFailed')
    && typeof record.dismissed === 'boolean';
}
