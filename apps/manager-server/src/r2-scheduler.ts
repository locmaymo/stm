import { logEvent, logLineText, type BackupManifest, type LogSink, type Profile, type TransferProgress } from '../../../packages/contracts/src/index.js';
import { BackupStore, type ArchiveSource } from '../../../packages/backup/src/index.js';
import { ProfileStore } from '../../../packages/profiles/src/index.js';
import { R2Manager, type SyncSource } from '../../../packages/r2/src/index.js';
import { hashFile, looksUnchanged, type HashedFile } from '../../../packages/r2/src/sync.js';
import { ioConcurrency, runPooled } from '../../../packages/platform/src/index.js';
import { lstat } from 'node:fs/promises';

/**
 * Trees that are rebuilt from what is beside them.
 *
 * A thumbnail is derived from a character card and a vector index from a chat,
 * so sending either one costs storage to hold something the machine can make
 * again in seconds. They are the largest part of a profile that nobody would
 * miss.
 */
const REGENERABLE = ['backups/', 'thumbnails/', 'vectors/', '_webpack/', '_cache/', 'node_modules/', '.git/'];

/**
 * The part of a profile worth sending every few minutes.
 *
 * These are small and are what an hour of use actually changes: the chats
 * themselves, the character cards, the lorebooks, the settings. Everything
 * else - backgrounds, uploaded images, extension payloads - is large, is
 * touched rarely, and rides on the slow clock instead. Both end up in the same
 * recovery point either way; the tier decides how often it is looked at, not
 * whether it is kept.
 */
const HOT_PREFIXES = [
  'chats/', 'characters/', 'groups/', 'group chats/', 'worlds/',
  // SillyTavern keeps presets in one directory per backend, spelled out, with
  // spaces. An earlier list guessed `presets/`, which exists in no version, so
  // editing a preset waited for the slow clock instead of the fast one.
  'OpenAI Settings/', 'TextGen Settings/', 'NovelAI Settings/', 'KoboldAI Settings/',
  'context/', 'instruct/', 'sysprompt/', 'reasoning/', 'QuickReplies/', 'themes/', 'movingUI/',
];
const HOT_FILES = ['settings.json', 'secrets.json', 'stats.json', 'config.yaml', 'config.yml'];

export interface BackupSchedulerOptions {
  readonly backups: BackupStore;
  readonly profiles: ProfileStore;
  readonly r2: R2Manager;
  readonly logger?: LogSink;
  readonly now?: () => Date;
  readonly tickIntervalMs?: number;
  /**
   * Keep the manager's own settings in the bucket too.
   *
   * Passed in rather than built here, because composing them needs the state
   * store, the runtime and the backup schedule, and this scheduler knows about
   * backups. It does nothing when the settings have not moved.
   */
  readonly saveSettings?: () => Promise<unknown>;
  /**
   * Where the log of what was asked of each provider is, so it can ride along
   * on the slow clock.
   *
   * It is not profile data and does not belong in a recovery point, but it is
   * the one other thing on the machine that cannot be made again.
   */
  readonly metricsFile?: string;
}

/** Small, bounded scheduler. It only runs after the manager is ready and never blocks requests. */
export class BackupScheduler {
  private readonly backups: BackupStore;
  private readonly profiles: ProfileStore;
  private readonly r2: R2Manager;
  private readonly logger: LogSink;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private reportedBusy = false;
  /**
   * The last reason a tick gave up, so a standing one is said once.
   *
   * Every minute is often enough that a reason which is not going to change on
   * its own - another machine holds the bucket, the ceiling is reached, the
   * network is down - fills the log with itself and buries the lines somebody
   * is reading it for.
   */
  private lastSkip: string | null = null;
  /** When the frequent tier last went up, so its clock survives a tick that did nothing. */
  private lastHotUploadAt: number | null = null;
  private readonly saveSettings: () => Promise<unknown>;
  private readonly metricsFile: string | null;

  public constructor(options: BackupSchedulerOptions) {
    this.backups = options.backups;
    this.profiles = options.profiles;
    this.r2 = options.r2;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.now = options.now ?? (() => new Date());
    this.tickIntervalMs = options.tickIntervalMs ?? 60_000;
    this.saveSettings = options.saveSettings ?? (async () => undefined);
    this.metricsFile = options.metricsFile ?? null;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
    this.timer.unref();
  }

  public async tick(): Promise<void> {
    if (this.running) return;
    if (this.backups.isOperationRunning()) {
      // A restore can hold the lock for many minutes. Saying so once is
      // useful; saying it every minute buries the lines that matter.
      if (!this.reportedBusy) {
        this.reportedBusy = true;
        this.logger(logEvent('backup.schedulePaused', '[backup] scheduled backup paused while another backup or restore is running'));
      }
      return;
    }
    this.reportedBusy = false;
    this.running = true;
    try {
      // Read here rather than after the local snapshot, because the settings
      // below need to know whether there is a bucket. Reading it is a local
      // file and decides nothing about the copy taken on this machine: a
      // bucket that is off, not set up or unreadable still has no say over
      // that, which is what it used to have when this interval came out of
      // the R2 settings.
      const config = await this.r2.getConfig();
      const remote = config.enabled && config.configured;
      /*
       * What the manager itself is set to: the password, the passcode, the
       * port, the schedules, the release being run.
       *
       * Before the profile and not behind it, because it does not need one
       * and used to be stuck behind the return below. A machine with nothing
       * installed yet is exactly the machine whose settings are worth having
       * in the bucket - it is a machine somebody is in the middle of setting
       * up - and it was the one machine that never sent them. Somebody who
       * set a password, moved SillyTavern's port, turned the tunnel on and
       * was then wiped before the install finished came back to none of it,
       * because the first upload of any of it was waiting on a profile that
       * did not exist yet.
       *
       * It does nothing when nothing has moved.
       */
      if (remote) await this.saveSettings();
      const profile = await this.profiles.getActive();
      if (!profile) return;
      // Safety copies expire on a clock, not only when something new is written.
      await this.backups.pruneCreated(profile.id);
      const fingerprint = await this.backups.fingerprint(profile);
      await this.runLocalSnapshot(profile, fingerprint, (await this.backups.getSchedule()).intervalMinutes);
      if (!remote) return;
      await this.runRemoteSync(profile, fingerprint, config);
      this.lastSkip = null;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      if (reason !== this.lastSkip) {
        this.lastSkip = reason;
        this.logger(logEvent('backup.scheduleSkipped', `[backup] scheduled backup skipped: ${reason}`, { reason }));
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * The local ZIP, which R2 does not replace.
   *
   * It is the copy a restore can use with nothing but this machine, and the one
   * the restore itself falls back on. R2 is the copy that survives this machine
   * being gone.
   */
  private async runLocalSnapshot(profile: Profile, fingerprint: string, intervalMinutes: number): Promise<BackupManifest | undefined> {
    // Turned off by the operator. R2, if it is on, still runs after this.
    if (intervalMinutes === 0) return undefined;
    const created = (await this.backups.list(profile.id))
      .filter((backup) => backup.source === 'created')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const latest = created[0];
    const due = !latest || (latest.fingerprint !== fingerprint && elapsed(this.now(), latest.createdAt) >= intervalMinutes * 60 * 1000);
    if (!due) return undefined;
    const manifest = await this.backups.create(profile, { kind: 'scheduled' });
    this.logger(logEvent('backup.scheduledSnapshot', `[backup] scheduled local snapshot ${manifest.name}`, { name: manifest.name }));
    return manifest;
  }

  private async runRemoteSync(profile: Profile, fingerprint: string, config: Awaited<ReturnType<R2Manager['getConfig']>>): Promise<void> {
    const coldDue = await this.r2.coldDue();
    const hotDue = this.lastHotUploadAt === null || this.now().getTime() - this.lastHotUploadAt >= config.schedule.hotIntervalMinutes * 60 * 1000;
    /*
     * The usage log, before the profile rather than after.
     *
     * On the slow clock, because it is appended to on every request SillyTavern
     * makes and on the fast clock it would be the only thing ever being sent -
     * except for the first one, which goes up as soon as there is anything to
     * send. Until it has been up once there is nothing in the bucket for a
     * wiped machine to come back to, so a machine wiped before its first slow
     * tick lost every figure it had ever recorded and came back reading zero -
     * which is the state every new installation starts in, on an account that
     * is also new. One upload of a log measured in kilobytes is not a cost
     * worth six hours of that.
     *
     * Asked of this machine's own record, so the question itself is free, and
     * answered yes for good after the first upload lands.
     */
    const metricsDue = coldDue || !await this.r2.metricsArchived();
    if (metricsDue && this.metricsFile) await this.r2.syncMetricsFile(this.metricsFile).catch(() => null);

    // Nothing has changed and the slow clock is not up: the cheapest tick there
    // is, and the common one. No further request is made at all.
    if (!coldDue && (!hotDue || config.lastFingerprint === fingerprint)) return;

    const tier = coldDue ? 'cold' : 'hot';
    const result = await syncProfileToR2({ profile, backups: this.backups, r2: this.r2, tier, fingerprint, logger: this.logger });
    this.lastHotUploadAt = this.now().getTime();
    this.logger(logEvent('backup.r2Synced', `[backup] ${tier === 'cold' ? 'full' : 'frequent'} R2 backup: ${result.uploadedChunks} chunk(s) sent, ${result.fileCount} file(s) recorded`, { tier, chunks: result.uploadedChunks, files: result.fileCount }));

    // Thinning needs a listing, which is charged. Asking for one after every
    // upload spent it on being told there was nothing to thin.
    if (await this.r2.pruneDue()) await this.r2.pruneSnapshots(profile.id);
    // The only sweep whose cost grows with how much is stored, so it runs on
    // its own slow clock rather than after every upload.
    if (await this.r2.reconcileDue()) await this.r2.reconcile();
  }

  public async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface SyncProfileOptions {
  readonly profile: Profile;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  /** `cold` walks the whole profile; `hot` only the part worth reading every few minutes. */
  readonly tier: 'hot' | 'cold';
  readonly fingerprint?: string;
  readonly logger?: LogSink;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

/**
 * Send one recovery point to R2, sharing everything the bucket already holds.
 *
 * The scheduler calls this on its clock and the panel calls it on demand; the
 * only difference is the tier, so both write the same shape of recovery point
 * and neither can drift from the other.
 */
export async function syncProfileToR2(options: SyncProfileOptions): Promise<Awaited<ReturnType<R2Manager['syncProfile']>>> {
  const { profile, backups, r2, tier } = options;
  const fingerprint = options.fingerprint ?? await backups.fingerprint(profile);
  const previous = await previousSnapshot(r2, profile.id, options.logger);
  const known = new Map((previous?.files ?? []).map((file) => [file.name, file]));
  const sources = (await backups.sources(profile)).filter((source) => !isRegenerable(source.name));
  const considered = tier === 'cold' ? sources : sources.filter((source) => isHot(source.name));
  const { hashed, carried } = await hashChanged(considered, known);
  // A hot run names the cold files from the last recovery point rather than
  // re-reading them, so what it writes is still a complete profile.
  const untouched = tier === 'cold' ? [] : (previous?.files ?? []).filter((file) => !isHot(file.name));
  return await r2.syncProfile({
    profile, sources: hashed, carried: [...carried, ...untouched], fingerprint, tier,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

/**
 * Hash what a stat says may have moved, and carry the rest forward untouched.
 *
 * Reading eleven thousand chat files to find the three that changed is the
 * expensive part of any incremental backup, and on a hosted volume it is the
 * only expensive part. Size and modification time answer it with one stat, and
 * a file whose answer has not moved keeps the chunk list it already had.
 */
async function hashChanged(sources: readonly ArchiveSource[], known: ReadonlyMap<string, HashedFile>): Promise<{ hashed: SyncSource[]; carried: HashedFile[] }> {
  const hashed: SyncSource[] = [];
  const carried: HashedFile[] = [];
  await runPooled(sources, ioConcurrency(), async (source) => {
    let details;
    try {
      details = await lstat(source.path);
    } catch {
      // Gone since the walk. It simply leaves this recovery point.
      return;
    }
    const previous = known.get(source.name);
    if (looksUnchanged(previous, details.size, details.mtimeMs)) { carried.push(previous); return; }
    const file = await hashFile(source.name, source.path);
    if (file) hashed.push({ file, path: source.path });
  });
  return { hashed, carried };
}

async function previousSnapshot(r2: R2Manager, profileId: string, logger?: LogSink): Promise<{ files: readonly HashedFile[] } | null> {
  try {
    return await r2.latestSnapshot(profileId);
  } catch (error: unknown) {
    // An unreadable index is not a reason to stop backing up. It only means
    // this run compares against nothing and sends more than it had to.
    const reason = error instanceof Error ? error.message : 'unknown error';
    logger?.(logEvent('backup.r2SnapshotUnreadable', `[backup] the last R2 recovery point could not be read, so this run compares against nothing: ${reason}`, { reason }));
    return null;
  }
}

function isRegenerable(name: string): boolean {
  return REGENERABLE.some((prefix) => name === prefix.slice(0, -1) || name.startsWith(prefix));
}

function isHot(name: string): boolean {
  return HOT_FILES.includes(name) || HOT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function elapsed(now: Date, timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : Number.POSITIVE_INFINITY;
}
