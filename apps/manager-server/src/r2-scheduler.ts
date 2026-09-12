import type { BackupManifest, Profile } from '../../../packages/contracts/src/index.js';
import { BackupStore } from '../../../packages/backup/src/index.js';
import { ProfileStore } from '../../../packages/profiles/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';

export interface BackupSchedulerOptions {
  readonly backups: BackupStore;
  readonly profiles: ProfileStore;
  readonly r2: R2Manager;
  readonly logger?: (line: string) => void;
  readonly now?: () => Date;
  readonly tickIntervalMs?: number;
}

/** Small, bounded scheduler. It only runs after the manager is ready and never blocks requests. */
export class BackupScheduler {
  private readonly backups: BackupStore;
  private readonly profiles: ProfileStore;
  private readonly r2: R2Manager;
  private readonly logger: (line: string) => void;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(options: BackupSchedulerOptions) {
    this.backups = options.backups;
    this.profiles = options.profiles;
    this.r2 = options.r2;
    this.logger = options.logger ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
    this.tickIntervalMs = options.tickIntervalMs ?? 60_000;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
    this.timer.unref();
  }

  public async tick(): Promise<void> {
    if (this.running) return;
    if (this.backups.isOperationRunning()) {
      this.logger('[backup] scheduled backup skipped while another backup or restore is running');
      return;
    }
    this.running = true;
    try {
      const profile = await this.profiles.getActive();
      if (!profile) return;
      const config = await this.r2.getConfig();
      const fingerprint = await this.backups.fingerprint(profile);
      const localBackups = (await this.backups.list(profile.id)).filter((backup) => backup.source === 'created').sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const latest = localBackups[0];
      const latestFull = localBackups.find((backup) => backup.name.startsWith(`${profile.name}-scheduled-full`));
      const fullDue = !latestFull || elapsed(this.now(), latestFull.createdAt) >= config.schedule.fullIntervalDays * 24 * 60 * 60 * 1000;
      const localDue = fullDue || !latest || (latest.fingerprint !== fingerprint && elapsed(this.now(), latest.createdAt) >= config.schedule.localIntervalMinutes * 60 * 1000);
      let localManifest: BackupManifest | undefined;
      if (localDue) {
        localManifest = await this.backups.create(profile, { name: fullDue ? `${profile.name}-scheduled-full` : `${profile.name}-scheduled` });
        this.logger(`[backup] scheduled local snapshot ${localManifest.name}`);
      }
      if (!config.enabled || !config.configured) return;
      const r2Due = config.enabled && config.configured && (!config.lastUploadAt || config.lastFingerprint !== fingerprint && elapsed(this.now(), config.lastUploadAt) >= config.schedule.r2IntervalHours * 60 * 60 * 1000);
      if (r2Due) {
        if (!localManifest && (!latest || latest.fingerprint !== fingerprint)) localManifest = await this.backups.create(profile, { name: `${profile.name}-r2` });
        const candidate = localManifest ?? latest;
        if (candidate) {
          const archivePath = await this.backups.getArchivePath(candidate.id);
          if (archivePath) await this.r2.uploadArchive(archivePath, candidate, fingerprint, false);
        }
      }
    } catch (error: unknown) {
      this.logger(`[backup] scheduled backup skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.running = false;
    }
  }

  public async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function elapsed(now: Date, timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : Number.POSITIVE_INFINITY;
}
