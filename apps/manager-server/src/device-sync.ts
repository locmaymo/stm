import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { logEvent, type DeviceSyncOutcome, type LogSink, type Profile } from '../../../packages/contracts/src/index.js';
import type { BackupStore } from '../../../packages/backup/src/index.js';
import { planSync, type Generation, type HashedFile, type R2Manager, type SyncAction } from '../../../packages/r2/src/index.js';
import { runPooled } from '../../../packages/platform/src/index.js';
import { hashProfile, syncProfileToR2, unheldFiles } from './r2-scheduler.js';

/**
 * Catching a device up with the others that share its data.
 *
 * The planner (`sync-plan.ts`) says what to do; this does it, to a profile
 * SillyTavern is not running on. Two rules hold throughout:
 *
 * Anything of this device's that is about to be replaced is in storage first,
 * as a recovery point. And every file arrives whole: written beside its place
 * and moved into it, so a run cut short leaves each file as one version or the
 * other, and the next run finishes the job from wherever this one stopped,
 * because what this device has agreed to is not moved on until the end.
 */

const OUTCOME_FILE = 'device-sync-outcome.json';
/** How many times a device catches up in one go before it stops chasing a line that keeps moving. */
const CATCH_UP_ROUNDS = 3;
const COMPARE_BLOCK = 1024 * 1024;
/**
 * Files SillyTavern rewrites by itself whenever it runs, so that two devices
 * have always both "changed" them. They are handled like any other - the
 * other device's version is taken, this one's is in the recovery point - but
 * telling the reader about it every time would be telling them nothing.
 */
const UNREMARKABLE = new Set(['stats.json']);

export interface CatchUpOptions {
  readonly profile: Profile;
  readonly r2: R2Manager;
  readonly backups: BackupStore;
  readonly logger?: LogSink;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

export interface CatchUpResult {
  /** Null when there was nothing to take in. */
  readonly outcome: DeviceSyncOutcome | null;
  /** Whether this device now holds something the others do not, to be sent. */
  readonly push: boolean;
}

/**
 * Take in what another device wrote, keeping what this one wrote.
 *
 * The caller makes sure SillyTavern is not running on the profile.
 */
export async function catchUp(options: CatchUpOptions): Promise<CatchUpResult> {
  const { profile, r2, backups } = options;
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;
  const place = await r2.syncPlace();
  if (!place || place.profileId !== profile.id) return { outcome: null, push: false };
  const head = await r2.sharedHead();
  if (!head) {
    // A line nobody has written to: everything here is this device's to send.
    if (place.files === null) { await r2.settleShared(); return { outcome: null, push: true }; }
    return { outcome: null, push: false };
  }
  const snapshot = await r2.readShared(head);
  const known = new Map((place.files ?? []).map((file) => [file.name, file]));
  const { hashed, carried } = await hashProfile(profile, backups, known);
  const onDisk = [...carried, ...hashed.map((source) => source.file)];
  // Files this device cannot hold count as held, or their absence would read as a deletion.
  const unheld = unheldFiles(place, new Set(onDisk.map((file) => file.name)));
  const plan = planSync({
    base: place.files,
    local: [...onDisk, ...unheld],
    head: snapshot.files,
    copyTag: `${r2.deviceLabel()} ${stamp(now())}`,
    windowsNames: platform === 'win32',
    caseInsensitive: platform === 'win32' || platform === 'darwin',
  });

  const displaced = plan.actions.filter((action) => action.kind === 'setAside' || action.kind === 'keepBoth');
  let recoveryPoint: string | null = null;
  if (displaced.length > 0) {
    const kept = await syncProfileToR2({ profile, backups, r2, tier: 'cold', generation: false, ...(options.logger ? { logger: options.logger } : {}) });
    recoveryPoint = kept.snapshot.id;
    options.logger?.(logEvent('sync.keptOwnCopy', `[sync] ${displaced.length} file(s) changed on both devices; this device's versions are in a recovery point before anything is replaced`, { count: displaced.length }));
  }

  const root = await backups.dataRoot(profile);
  const applied = await applyPlan(root, plan.actions, r2);
  await r2.adoptShared(head, snapshot.files, plan.skipped.map((entry) => entry.name));

  const outcome: DeviceSyncOutcome = {
    at: now().toISOString(),
    from: head.device.label,
    taken: applied.taken,
    removed: applied.removed,
    keptBoth: applied.keptBoth,
    setAside: plan.actions.filter((action) => action.kind === 'setAside' && !UNREMARKABLE.has(action.name)).map((action) => action.name),
    skipped: plan.skipped.map((entry) => entry.name),
    recoveryPoint,
  };
  options.logger?.(logEvent('sync.caughtUp', `[sync] caught up with ${head.device.label}: ${applied.taken} file(s) taken, ${applied.removed} removed, ${applied.keptBoth.length} chat(s) kept twice`, { label: head.device.label, taken: applied.taken, removed: applied.removed, kept: applied.keptBoth.length }));
  return { outcome, push: plan.push || applied.localKept };
}

interface Applied {
  taken: number;
  removed: number;
  keptBoth: string[];
  /** Whether a chat this device had more of was left as it is, to be sent. */
  localKept: boolean;
}

async function applyPlan(root: string, actions: readonly SyncAction[], r2: R2Manager): Promise<Applied> {
  const applied: Applied = { taken: 0, removed: 0, keptBoth: [], localKept: false };
  for (const action of actions) {
    if (action.kind !== 'remove') continue;
    const target = safeTarget(root, action.name);
    await rm(target, { force: true });
    await pruneEmpty(root, dirname(target));
    applied.removed += 1;
  }
  const writes = actions.filter((action) => action.kind === 'take' || action.kind === 'setAside');
  await runPooled(writes, await r2.transfers(), async (action) => {
    const file = action.kind === 'take' ? action.file : action.kind === 'setAside' ? action.head : null;
    if (!file) return;
    const target = safeTarget(root, action.name);
    await moveInto(await fetchBeside(r2, file, target), target, file);
    applied.taken += 1;
  });
  // One at a time: each may rename a file another is about to look for.
  const regrouped: Array<{ from: string; to: string }> = [];
  for (const action of actions) {
    if (action.kind !== 'keepBoth') continue;
    const target = safeTarget(root, action.name);
    const arrived = await fetchBeside(r2, action.head, target);
    if (action.mayExtend === 'head' && await startsWith(arrived, target)) {
      // The other device's chat is this one with more said. One chat, the longer.
      await moveInto(arrived, target, action.head);
      applied.taken += 1;
      continue;
    }
    if (action.mayExtend === 'local' && await startsWith(target, arrived)) {
      await rm(arrived, { force: true });
      applied.localKept = true;
      continue;
    }
    const copy = safeTarget(root, action.as);
    await mkdir(dirname(copy), { recursive: true });
    await rename(target, copy);
    await moveInto(arrived, target, action.head);
    applied.keptBoth.push(action.as);
    applied.taken += 1;
    if (action.chat === 'group') regrouped.push({ from: chatId(action.name), to: chatId(action.as) });
  }
  if (regrouped.length > 0) await listInGroups(root, regrouped);
  return applied;
}

/** Download a file's chunks into a temporary file next to where it belongs. */
async function fetchBeside(r2: R2Manager, file: HashedFile, target: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.stm-sync-${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w');
  try {
    for (const chunk of file.chunks) await handle.write(await r2.readBlob(chunk.hash, file.name));
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

/**
 * Put an arrived file in its place, with the time the other device saw on it.
 *
 * The time is what lets the next backup see with one stat that this file is
 * the one the list names, instead of reading it again to find that out.
 */
async function moveInto(temporary: string, target: string, file: HashedFile): Promise<void> {
  const seconds = file.mtimeMs / 1000;
  await utimes(temporary, seconds, seconds).catch(() => undefined);
  await rename(temporary, target);
}

/** Whether the file at `whole` begins with everything in the file at `part`. */
async function startsWith(whole: string, part: string): Promise<boolean> {
  const [wholeSize, partSize] = await Promise.all([stat(whole).then((details) => details.size), stat(part).then((details) => details.size)]);
  if (partSize > wholeSize) return false;
  const [left, right] = await Promise.all([open(whole, 'r'), open(part, 'r')]);
  try {
    const a = Buffer.alloc(COMPARE_BLOCK);
    const b = Buffer.alloc(COMPARE_BLOCK);
    for (let position = 0; position < partSize; position += COMPARE_BLOCK) {
      const length = Math.min(COMPARE_BLOCK, partSize - position);
      await Promise.all([left.read(a, 0, length, position), right.read(b, 0, length, position)]);
      if (a.compare(b, 0, length, 0, length) !== 0) return false;
    }
    return true;
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}

/**
 * Add a group chat's second copy to the group it belongs to.
 *
 * A character's chats are whatever files are in its folder. A group's are the
 * ones its own file lists, so a copy nothing lists would be on the disk and
 * nowhere on the screen.
 */
async function listInGroups(root: string, copies: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
  const directory = join(root, 'groups');
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const group = JSON.parse(await readFile(path, 'utf8')) as { chats?: unknown };
      if (!Array.isArray(group.chats)) continue;
      const added = copies.filter((copy) => (group.chats as unknown[]).includes(copy.from) && !(group.chats as unknown[]).includes(copy.to));
      if (added.length === 0) continue;
      for (const copy of added) group.chats.push(copy.to);
      const temporary = `${path}.stm-sync-${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(group, null, 4), 'utf8');
      await rename(temporary, path);
    } catch {
      // A group file that cannot be read is left alone; the copy is still on the disk.
    }
  }
}

function chatId(name: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1);
  return leaf.replace(/\.jsonl$/iu, '');
}

/** Where a name from a file list belongs, refusing one that would leave the profile. */
function safeTarget(root: string, name: string): string {
  const base = resolve(root);
  const candidate = resolve(base, ...name.split('/'));
  const inside = relative(base, candidate);
  if (inside === '' || inside.startsWith('..') || resolve(base, inside) !== candidate) throw new Error(`A shared file name would leave the profile: ${name}`);
  return candidate;
}

/** Remove the directories a deletion emptied, up to the profile's own. */
async function pruneEmpty(root: string, directory: string): Promise<void> {
  const base = resolve(root);
  let current = resolve(directory);
  while (current !== base && current.startsWith(base)) {
    try { await rmdir(current); } catch { return; }
    current = dirname(current);
  }
}

/** A time a file name can carry on every file system: `2026-11-16 14-05`. */
function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

export interface DeviceSyncOptions {
  readonly r2: R2Manager;
  readonly backups: BackupStore;
  /** The manager's state directory, for what the last catch-up did. */
  readonly stateDirectory: string;
  readonly logger?: LogSink;
  readonly now?: () => Date;
  /** Whether SillyTavern is running, and how to stop it. */
  readonly isRunning: () => boolean;
  readonly stop: () => Promise<unknown>;
  /** Asked for when this device holds something to send and should not wait for the clock. */
  readonly requestPush?: () => void;
}

/**
 * What the manager does about sharing, around SillyTavern's life.
 *
 * Before it starts: catch up, then say this device is the one in use. While it
 * runs: look, once a minute, for another device having said the same - and
 * stop, because two SillyTaverns writing one set of data is the one thing this
 * whole arrangement exists to prevent.
 */
export class DeviceSync {
  private readonly options: DeviceSyncOptions;
  private readonly logger: LogSink;
  private watching = false;
  private offlineSaid = false;

  public constructor(options: DeviceSyncOptions) {
    this.options = options;
    this.logger = options.logger ?? (() => undefined);
  }

  /**
   * Called with SillyTavern stopped and about to start on `profile`.
   *
   * Never refuses the start. A device with no network starts on what it has;
   * if another device changed things meanwhile, both sets of changes are kept
   * when this one next catches up.
   */
  public async beforeStart(profile: Profile): Promise<void> {
    const { r2, backups } = this.options;
    const place = await r2.syncPlace().catch(() => null);
    if (!place || place.profileId !== profile.id) return;
    try {
      let push = false;
      for (let round = 0; round < CATCH_UP_ROUNDS; round += 1) {
        const result = await backups.runExclusive(() => catchUp({ profile, r2, backups, logger: this.logger, ...(this.options.now ? { now: this.options.now } : {}) }));
        push ||= result.push;
        if (result.outcome && (result.outcome.keptBoth.length > 0 || result.outcome.setAside.length > 0 || result.outcome.skipped.length > 0)) await this.remember(result.outcome);
        // Another device may have moved on while this one was reading; then once more.
        if (await r2.takeTurn()) break;
      }
      this.offlineSaid = false;
      if (push) this.options.requestPush?.();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger(logEvent('sync.catchUpFailed', `[sync] this device could not check for newer data before starting, so it starts on what it has: ${reason}`, { reason }));
    }
  }

  /**
   * The device that holds the shared data now, when it is not this one.
   *
   * Asked before a start nobody pressed for. Storage that cannot be reached
   * answers "nobody": a device that is offline starts on what it has.
   */
  public async inUseElsewhere(): Promise<string | null> {
    const { r2 } = this.options;
    try {
      const place = await r2.syncPlace();
      // Not sharing, or joined and still to take the shared data in, which a start does.
      if (!place || place.files === null) return null;
      if (place.behind) return place.behind.label;
      return (await r2.sharedHead())?.device.label ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Called on the scheduler's clock. Stops SillyTavern when another device has
   * said it is the one in use.
   */
  public async watch(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      const { r2 } = this.options;
      const place = await r2.syncPlace();
      if (!place || place.files === null) return;
      let ahead: Generation | { device: { label: string } } | null = place.behind ? { device: { label: place.behind.label } } : null;
      if (!ahead) {
        try {
          ahead = await r2.sharedHead();
          this.offlineSaid = false;
        } catch (error: unknown) {
          if (!this.offlineSaid) {
            this.offlineSaid = true;
            const reason = error instanceof Error ? error.message : 'unknown error';
            this.logger(logEvent('sync.watchFailed', `[sync] storage could not be asked whether another device is in use: ${reason}`, { reason }));
          }
          return;
        }
      }
      if (ahead && this.options.isRunning()) await this.handOver(ahead.device.label);
    } finally {
      this.watching = false;
    }
  }

  /** Stop SillyTavern because another device is the one in use now. */
  public async handOver(label: string): Promise<void> {
    if (!this.options.isRunning()) return;
    this.logger(logEvent('sync.handedOver', `[sync] ${label} is using this data now, so SillyTavern was stopped here; start it again on this device to carry on from there`, { label }));
    await this.options.stop();
  }

  /** What the last catch-up that needs telling about did, until it is dismissed. */
  public async outcome(): Promise<DeviceSyncOutcome | null> {
    try {
      return JSON.parse(await readFile(join(this.options.stateDirectory, OUTCOME_FILE), 'utf8')) as DeviceSyncOutcome;
    } catch {
      return null;
    }
  }

  public async dismissOutcome(): Promise<void> {
    await rm(join(this.options.stateDirectory, OUTCOME_FILE), { force: true });
  }

  /** Added to what is already waiting to be read, so two catch-ups in a row lose nothing. */
  private async remember(outcome: DeviceSyncOutcome): Promise<void> {
    const earlier = await this.outcome();
    const merged: DeviceSyncOutcome = earlier ? {
      ...outcome,
      taken: earlier.taken + outcome.taken,
      removed: earlier.removed + outcome.removed,
      keptBoth: [...earlier.keptBoth, ...outcome.keptBoth],
      setAside: [...new Set([...earlier.setAside, ...outcome.setAside])],
      skipped: [...new Set([...earlier.skipped, ...outcome.skipped])],
      recoveryPoint: outcome.recoveryPoint ?? earlier.recoveryPoint,
    } : outcome;
    await mkdir(this.options.stateDirectory, { recursive: true });
    const target = join(this.options.stateDirectory, OUTCOME_FILE);
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }
}
