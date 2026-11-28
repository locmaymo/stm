import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { claimSlot, readSlot, type SlotOptions } from './slot.js';
import { R2Error, R2HttpError, type ObjectStore } from './store.js';
import type { HashedFile } from './sync.js';

/**
 * One set of data that several devices take turns with.
 *
 * The line is a row of numbered generations. Each is a recovery point that
 * some device declared to be the newest state of the data, and the number is
 * what was fought over to say so: a device sends everything it has, then
 * reaches for the number after the one it started from. Getting it makes that
 * recovery point the head. Not getting it means another device moved the line
 * on, and this one has to catch up before it may add to it.
 *
 * Nothing here locks anything and nothing waits for another device to answer.
 * A phone that goes to sleep mid-sentence holds nothing the others need.
 *
 * In storage, under `sync/`:
 *   line.json       which line this storage holds, written once
 *   gen/<number>    one generation, a slot; see `slot.ts`
 *   head.json       the newest number somebody knows of - a hint, not the truth
 *   sweep.json      changed whenever unwanted chunks were deleted
 *
 * On the device: the generation it last agreed with, and the file list of that
 * moment, which is what tells its own changes from everybody else's.
 */

const STATE_FILE = 'device-sync.json.gz';
const SCHEMA_VERSION = 1 as const;
/** Generations kept behind the head; older ones are removed as new ones land. */
const GENERATIONS_KEPT = 20;
/** How far past the hint a device looks before deciding the hint is nonsense. */
const PROBE_LIMIT = 500;

export interface LineRecord {
  readonly schemaVersion: 1;
  readonly lineId: string;
  readonly createdAt: string;
  /** The device that turned syncing on, as its label. */
  readonly createdBy: string;
}

export interface LineDevice {
  readonly id: string;
  readonly label: string;
}

export interface Generation {
  readonly schemaVersion: 1;
  readonly seq: number;
  /** The recovery point that is the data at this generation. */
  readonly snapshotId: string;
  readonly device: LineDevice;
  /** The writer's own clock, for showing only. Order comes from `seq`. */
  readonly at: string;
  /** Makes two attempts at one number different bytes. */
  readonly nonce: string;
  /**
   * Written by a device as it stopped being used: SillyTavern stopped there,
   * or its manager closed. The data it names is still the newest, and another
   * device still takes it in before it sends anything, but nobody is using it
   * now, so another device may start without being asked to take over.
   * Absent on everything else, and on everything an older manager wrote.
   */
  readonly released?: true;
}

/** What this device knows about its place on the line. */
export interface LineState {
  readonly schemaVersion: 1;
  readonly lineId: string;
  /** The profile on this device that holds the line's data. */
  readonly profileId: string;
  /** The generation this device last agreed with; 0 before the first one. */
  readonly seq: number;
  readonly snapshotId: string | null;
  /**
   * The file list at `seq`. Null on a device that joined and has not caught up
   * yet: it has nothing to tell its own changes from the line's by.
   */
  readonly files: readonly HashedFile[] | null;
  /** The device that wrote `seq`, for saying where the data last came from. */
  readonly writtenBy: string | null;
  /** Whether that device is this one: whether this device is the one in use. */
  readonly mine: boolean;
  /**
   * Names in `files` that this device's file system cannot hold. They are not
   * on its disk, and every file list it sends must name them all the same.
   */
  readonly unheld: readonly string[];
  readonly syncedAt: string | null;
  /** The sweep this device's list of stored chunks is good for; see `sweep.json`. */
  readonly sweep: string | null;
  /**
   * Set when another device took the number this one reached for. Until this
   * device catches up it adds nothing to the line.
   */
  readonly behind: { readonly seq: number; readonly label: string; readonly at: string } | null;
}

export interface DeviceLineOptions {
  /** The manager's state directory. */
  readonly directory: string;
  /** The prefix every key of the manager sits under, with its trailing slash. */
  readonly prefix: string;
  readonly now?: () => Date;
  readonly slot?: SlotOptions;
}

export type CommitResult =
  | { readonly won: true; readonly generation: Generation }
  /** `head` is null when the attempt was withdrawn and may simply be made again. */
  | { readonly won: false; readonly head: Generation | null };

export class DeviceLine {
  private readonly directory: string;
  private readonly prefix: string;
  private readonly now: () => Date;
  private readonly slot: SlotOptions;
  private cached: LineState | null | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  /** The housekeeping that follows a generation; see `commit`. */
  private tidying: Promise<void> = Promise.resolve();

  /** Resolves once the housekeeping after the last generation is done. */
  public async tidied(): Promise<void> { await this.tidying; }

  public constructor(options: DeviceLineOptions) {
    this.directory = options.directory;
    this.prefix = `${options.prefix}sync/`;
    this.now = options.now ?? (() => new Date());
    this.slot = options.slot ?? {};
  }

  /** Whether a key belongs to the line, for everything that sorts a listing by kind. */
  public owns(key: string): boolean {
    return key.startsWith(this.prefix);
  }

  /** This device's place on the line, or null when it is on none. */
  public async state(): Promise<LineState | null> {
    if (this.cached !== undefined) return this.cached;
    try {
      this.cached = parseState(JSON.parse(gunzipSync(await readFile(join(this.directory, STATE_FILE))).toString('utf8')));
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      this.cached = null;
    }
    return this.cached;
  }

  /** The line this storage holds, or null when nobody has turned syncing on. */
  public async remote(store: ObjectStore): Promise<LineRecord | null> {
    const stored = await readSlot(store, this.key('line.json'));
    return stored ? parseLine(stored) : null;
  }

  /**
   * Turn syncing on from this device, or find that another device just did.
   *
   * The line takes the profile's id, so the recovery points this device has
   * already sent are the line's from the first moment.
   */
  public async create(store: ObjectStore, profileId: string, label: string): Promise<{ readonly record: LineRecord; readonly created: boolean }> {
    const proposed: LineRecord = { schemaVersion: SCHEMA_VERSION, lineId: profileId, createdAt: this.now().toISOString(), createdBy: label.slice(0, 120) };
    const body = Buffer.from(JSON.stringify({ ...proposed, nonce: randomBytes(8).toString('hex') }), 'utf8');
    const result = await claimSlot(store, this.key('line.json'), body, this.slot);
    if (!result.holder) throw new R2Error('sync_busy', 'Storage was too slow to turn syncing on. Try again.');
    return { record: parseLine(result.holder), created: result.won };
  }

  /**
   * Put this device on a line. With `files` null it still has to catch up; the
   * device that started the line starts from an empty list, so everything it
   * holds is its own to send.
   */
  public async join(record: LineRecord, profileId: string, files: readonly HashedFile[] | null): Promise<LineState> {
    const state: LineState = { schemaVersion: SCHEMA_VERSION, lineId: record.lineId, profileId, seq: 0, snapshotId: null, files, writtenBy: null, mine: false, unheld: [], syncedAt: null, sweep: null, behind: null };
    await this.save(state);
    return state;
  }

  /** Take this device off the line. Storage is left as it is. */
  public async leave(): Promise<void> {
    await this.save(null);
  }

  /**
   * The newest generation, if it is newer than what this device has.
   *
   * The hint says roughly where the head is; from there the numbers are tried
   * one by one, because the hint is written after the generation and may be
   * one or two behind. A device whose own number is older than the hint is
   * behind without trying anything.
   */
  public async head(store: ObjectStore, from: number): Promise<Generation | null> {
    const hinted = await this.hint(store);
    let seq = Math.max(from, hinted);
    let found: Generation | null = null;
    for (let step = 0; step < PROBE_LIMIT; step += 1) {
      const next = await readSlot(store, this.generationKey(seq + 1));
      if (!next) break;
      found = parseGeneration(next);
      seq += 1;
    }
    if (found) return found;
    if (seq === from) return null;
    const stored = await readSlot(store, this.generationKey(seq));
    if (!stored) throw new R2Error('sync_head_missing', 'Storage names a newer state of the data than it holds. Try again in a moment.');
    return parseGeneration(stored);
  }

  /**
   * Declare a recovery point the newest state of the data.
   *
   * Called only after everything it names is in storage. Losing is an answer,
   * not a failure: the line moved, and `head` says who moved it.
   */
  public async commit(store: ObjectStore, snapshotId: string, files: readonly HashedFile[], device: LineDevice, options: { readonly released?: boolean } = {}): Promise<CommitResult> {
    const state = await this.state();
    if (!state) throw new R2Error('sync_off', 'This device is not syncing');
    const at = this.now().toISOString();
    const generation: Generation = { schemaVersion: SCHEMA_VERSION, seq: state.seq + 1, snapshotId, device: { id: device.id, label: device.label.slice(0, 120) }, at, nonce: randomBytes(8).toString('hex'), ...(options.released ? { released: true as const } : {}) };
    const result = await claimSlot(store, this.generationKey(generation.seq), Buffer.from(JSON.stringify(generation), 'utf8'), this.slot);
    if (!result.won) {
      const head = result.holder ? parseGeneration(result.holder) : null;
      if (head) await this.save({ ...state, behind: { seq: head.seq, label: head.device.label, at: head.at } });
      return { won: false, head };
    }
    // A device that let go is not the one in use: the next start says so again.
    await this.save({ ...state, seq: generation.seq, snapshotId, files, writtenBy: generation.device.label, mine: !options.released, syncedAt: at, behind: null });
    // Neither is needed for the generation to stand; both make the next reader's
    // work shorter. Not waited for: on Drive they are seconds, added to every send.
    // One after another, so an older number is never written over a newer one.
    this.tidying = this.tidying.then(async () => {
      await store.putObject(this.key('head.json'), Buffer.from(JSON.stringify({ schemaVersion: SCHEMA_VERSION, seq: generation.seq }), 'utf8'), 'application/json').catch(() => undefined);
      if (generation.seq > GENERATIONS_KEPT) await store.deleteObject(this.generationKey(generation.seq - GENERATIONS_KEPT)).catch(() => undefined);
    });
    return { won: true, generation };
  }

  /**
   * Record that this device now holds what a generation holds, apart from the
   * files named in `unheld`, which it cannot.
   */
  public async adopt(generation: Generation, files: readonly HashedFile[], unheld: readonly string[] = []): Promise<void> {
    const state = await this.state();
    if (!state) throw new R2Error('sync_off', 'This device is not syncing');
    await this.save({ ...state, seq: generation.seq, snapshotId: generation.snapshotId, files, writtenBy: generation.device.label, mine: false, unheld: [...unheld], syncedAt: this.now().toISOString(), behind: null });
  }

  /**
   * A device that joined a line nobody has written to yet has nothing to catch
   * up with: everything it holds is its own to send.
   */
  public async settle(): Promise<void> {
    const state = await this.state();
    if (state && state.files === null) await this.save({ ...state, files: [] });
  }

  /** Note that another device is ahead, so this one stops adding to the line. */
  public async fellBehind(head: Generation): Promise<void> {
    const state = await this.state();
    if (!state || (state.behind && state.behind.seq >= head.seq)) return;
    await this.save({ ...state, behind: { seq: head.seq, label: head.device.label, at: head.at } });
  }

  /**
   * The mark of the last sweep, or null when there has been none.
   *
   * Every device keeps its own list of the chunks storage already holds, so it
   * can skip sending them. A sweep deletes chunks, on whichever device ran it,
   * and the other devices' lists then name chunks that are gone. The mark is
   * how they find out: a mark they have not seen means the list is rebuilt
   * from storage before it is trusted again.
   */
  public async sweepMark(store: ObjectStore): Promise<string | null> {
    const stored = await read(store, this.key('sweep.json'));
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored.toString('utf8')) as { id?: unknown };
      return typeof parsed.id === 'string' ? parsed.id : null;
    } catch {
      return null;
    }
  }

  /** Leave a new mark, before the first chunk of a sweep is deleted. */
  public async markSweep(store: ObjectStore): Promise<string> {
    const id = randomBytes(8).toString('hex');
    await store.putObject(this.key('sweep.json'), Buffer.from(JSON.stringify({ schemaVersion: SCHEMA_VERSION, id, at: this.now().toISOString() }), 'utf8'), 'application/json');
    await this.sawSweep(id);
    return id;
  }

  /** Record that this device's list of stored chunks is good for this sweep. */
  public async sawSweep(id: string | null): Promise<void> {
    const state = await this.state();
    if (!state || state.sweep === id) return;
    await this.save({ ...state, sweep: id });
  }

  private async hint(store: ObjectStore): Promise<number> {
    const stored = await read(store, this.key('head.json')).catch(() => null);
    if (!stored) return 0;
    try {
      const seq = (JSON.parse(stored.toString('utf8')) as { seq?: unknown }).seq;
      return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
    } catch {
      return 0;
    }
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** Padded so that a listing shows the generations in order. */
  private generationKey(seq: number): string {
    return this.key(`gen/${String(seq).padStart(10, '0')}.json`);
  }

  private async save(next: LineState | null): Promise<void> {
    const operation = async (): Promise<void> => {
      const target = join(this.directory, STATE_FILE);
      if (next === null) {
        await rm(target, { force: true });
        this.cached = null;
        return;
      }
      await mkdir(this.directory, { recursive: true });
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, gzipSync(Buffer.from(JSON.stringify(next), 'utf8')), { mode: 0o600 });
        await rename(temporary, target);
      } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.cached = next;
    };
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }
}

async function read(store: ObjectStore, key: string): Promise<Buffer | null> {
  try {
    return await store.getObject(key);
  } catch (error: unknown) {
    if (error instanceof R2HttpError && error.status === 404) return null;
    throw error;
  }
}

function parseLine(stored: Buffer): LineRecord {
  const value = parseJson(stored);
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.lineId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value.lineId)) {
    throw new R2Error('sync_unreadable', 'Storage holds a sync record this version cannot read. Update the manager on this device.');
  }
  return { schemaVersion: SCHEMA_VERSION, lineId: value.lineId, createdAt: typeof value.createdAt === 'string' ? value.createdAt : '', createdBy: typeof value.createdBy === 'string' ? value.createdBy.slice(0, 120) : '' };
}

function parseGeneration(stored: Buffer): Generation {
  const value = parseJson(stored);
  const device = isRecord(value) && isRecord(value.device) ? value.device : null;
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1 || typeof value.snapshotId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/u.test(value.snapshotId) || !device) {
    throw new R2Error('sync_unreadable', 'Storage holds a sync record this version cannot read. Update the manager on this device.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: value.seq,
    snapshotId: value.snapshotId,
    device: { id: typeof device.id === 'string' ? device.id.slice(0, 80) : '', label: typeof device.label === 'string' ? device.label.slice(0, 120) : '' },
    at: typeof value.at === 'string' ? value.at : '',
    nonce: typeof value.nonce === 'string' ? value.nonce : '',
    ...(value.released === true ? { released: true as const } : {}),
  };
}

function parseState(value: unknown): LineState {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.lineId !== 'string' || typeof value.profileId !== 'string' || typeof value.seq !== 'number') {
    throw new Error('Unsupported device sync state');
  }
  const behind = isRecord(value.behind) && typeof value.behind.seq === 'number' ? { seq: value.behind.seq, label: typeof value.behind.label === 'string' ? value.behind.label : '', at: typeof value.behind.at === 'string' ? value.behind.at : '' } : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    lineId: value.lineId,
    profileId: value.profileId,
    seq: value.seq,
    snapshotId: typeof value.snapshotId === 'string' ? value.snapshotId : null,
    files: Array.isArray(value.files) ? value.files as HashedFile[] : null,
    writtenBy: typeof value.writtenBy === 'string' ? value.writtenBy : null,
    mine: value.mine === true,
    unheld: Array.isArray(value.unheld) ? value.unheld.filter((name): name is string => typeof name === 'string') : [],
    syncedAt: typeof value.syncedAt === 'string' ? value.syncedAt : null,
    sweep: typeof value.sweep === 'string' ? value.sweep : null,
    behind,
  };
}

function parseJson(stored: Buffer): unknown {
  try {
    return JSON.parse(stored.toString('utf8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
