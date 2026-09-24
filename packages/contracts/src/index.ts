export * from './table-query.js';
export * from './table-fields.js';

/**
 * What kind of machine this manager is on.
 *
 * `hosted` is any workspace a provider runs for somebody: a container built
 * from a checkout, started on demand and stopped when nobody is looking. It is
 * deliberately not named after a provider - this project has no relationship
 * with any of them, trusts none of them by name, and treats every one of them
 * the same: as a machine whose storage may not be kept.
 */
export type PlatformKind = 'windows' | 'linux' | 'termux' | 'docker' | 'hosted' | 'unknown';

/** The ports this project ships with, before anything moves them. */
export interface ManagerPorts {
  readonly manager: 7860;
  readonly sillyTavern: 8002;
  /** Where the guarded door to SillyTavern listens; see AccessGatewayState. */
  readonly access: 8001;
}

/**
 * The ports a running manager is actually using.
 *
 * `port` is SillyTavern's, which the console can move. The reserved pair is
 * fixed for the life of the process and comes back with it so the panel can
 * show what a rejected number collided with, and say where to change those two
 * instead - the environment, not this page.
 */
export interface PortSettings {
  readonly port: number;
  readonly reserved: {
    readonly manager: number;
    readonly access: number;
  };
}

export interface ManagerState {
  readonly schemaVersion: 1;
  readonly managerVersion: string;
  readonly installId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly adminConfigured: boolean;
  readonly setupAcceptedAt: string | null;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  readonly platform: PlatformKind;
  readonly storageRoot: string;
  readonly storageDurable: boolean;
}

export interface AdminSession {
  readonly expiresAt: string;
  readonly csrfToken: string;
}

export interface SetupStatus {
  readonly setupRequired: boolean;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  readonly notice: {
    readonly telemetry: string;
    readonly terms: string;
    readonly disclaimer: string;
  };
  /**
   * How this manager can be opened.
   *
   * A password is always one of them once one is set. A Cloudflare account is
   * offered where this build has an OAuth client, and is what makes a machine
   * that loses its disk usable: signing in is the whole of the setup, and
   * everything that was on the machine before comes back with it.
   *
   * Absent on a manager too old to have been asked.
   */
  readonly cloudflareSignIn?: {
    /** Whether this build can start a sign-in at all. */
    readonly available: boolean;
    /** What the account that already owns this manager is called, if one does. */
    readonly owner: string | null;
  };
}

/**
 * Whether the terms in force are the ones this manager was accepted under.
 *
 * The documents are revised as the software changes, and an installation set
 * up eighteen months ago agreed to wording that has since moved. Nothing about
 * that is visible from inside the console: the text ships compiled into the
 * program, so a manager that has just been updated is showing a revision its
 * reader has never been asked about.
 *
 * So the revision the state file recorded at setup is compared against the one
 * the program carries, and where they differ the reader is asked once. What is
 * being asked for is an acknowledgement, not a second installation: nothing is
 * withheld and nothing is erased if it is left unanswered.
 */
export interface LegalReview {
  /** Whether the revision in force is one nobody here has acknowledged. */
  readonly required: boolean;
  /** The revision the program carries, as the legal package labels it. */
  readonly revision: string;
  /** The date that revision took effect, which is what is compared. */
  readonly effective: string;
  /** The date on record for this installation, written when it was set up. */
  readonly accepted: string;
  /** When the reader last acknowledged a revision, if they ever have. */
  readonly acknowledgedAt: string | null;
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly manager: {
    readonly version: string;
    /** Where the console is actually listening, which `STM_PORT` can move. */
    readonly port: number;
  };
  readonly setupRequired: boolean;
  readonly uptimeSeconds: number;
  readonly storage: {
    readonly durable: boolean;
  };
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * What the manager does on its own way up, as opposed to what SillyTavern is
 * configured to do once it is running.
 *
 * Kept apart from ConfigSettings because those are written into the installed
 * runtime's own config.yaml and belong to the version installed. This belongs
 * to the manager and outlives every version it installs.
 */
export interface StartupSettings {
  /** Start SillyTavern when the manager starts. On unless it is turned off. */
  readonly autoStartSillyTavern: boolean;
}

/**
 * Where saver mode's answer came from.
 *
 * `environment` is STM_SAVER, which the panel shows and cannot change;
 * `choice` is the panel's own switch; `machine` is the default the machine
 * gets when nobody has said anything - see `SaverState.reason`.
 */
export type SaverSource = 'environment' | 'choice' | 'machine';

/**
 * What told the manager that files here are kept in memory.
 *
 * `environment` is STM_STORAGE_IN_MEMORY, which settles it either way;
 * `serverless` is a container host that follows the Knative contract and sets
 * K_SERVICE; `memoryFilesystem` is a data directory on tmpfs or ramfs.
 */
export type StorageSignal = 'environment' | 'serverless' | 'memoryFilesystem';

/**
 * Whether a file written here takes disk or the memory the programs run in.
 *
 * Two different machines can both have four gigabytes of memory: an old
 * laptop or a phone with a disk many times that, and a container with no disk
 * at all, where every file written is held in the same four gigabytes. Only
 * the second is short of room for a profile.
 */
export interface StorageMedium {
  readonly inMemory: boolean;
  /** What decided it, or null when nothing said memory and the disk is assumed. */
  readonly signal: StorageSignal | null;
}

/**
 * Whether the manager keeps its disk and memory use to the minimum.
 *
 * Some hosts give a container a few gigabytes for memory and disk together,
 * and a restore that held a profile three times over - the upload, the
 * safety copy, the files - ran them out. Saver mode takes no local archives,
 * and a copy in R2 stands in for the safety copy.
 */
export interface SaverState {
  readonly enabled: boolean;
  readonly source: SaverSource;
  /**
   * Why the machine would have it on by itself: its files are kept in memory,
   * or its disk was nearly full at startup. Null when neither is so.
   */
  readonly reason: 'inMemory' | 'lowDisk' | null;
  readonly storage: StorageMedium;
  /** The memory this manager may use, as it measured it at startup. */
  readonly memoryBytes: number;
  /** Free disk at startup; null when files are kept in memory or the disk could not be asked. */
  readonly diskBytes: number | null;
  /** Below this much free disk, saver mode is on unless somebody says otherwise. */
  readonly diskThresholdBytes: number;
}

/**
 * Whether the manager keeps itself online where being unused ends a program.
 *
 * A battery saver, or the place this is running, can put the manager to sleep
 * once nothing has used it for a while, and SillyTavern goes with it - so the
 * manager reaches its own address on a clock, which says it is still in use.
 *
 * The address is the machine's own, never the Worker or the tunnel in front of
 * it: those leave the machine and come back through Cloudflare, which spends
 * an allowance on a request no reader made. There is always one, so this is
 * never a switch that does nothing: where nothing from outside has reached
 * this manager, it holds its own loopback address, which is what a battery
 * saver on somebody's own computer is watching anyway.
 */
/**
 * How often the manager reaches its own address, and the range that allows.
 *
 * Here rather than beside the keeper because three places need to agree on
 * them: the keeper itself, the state file that remembers the choice, and the
 * record in the bucket that carries it to the next machine. A value from any
 * of those is held inside this range rather than refused, so a file somebody
 * edited by hand is corrected instead of stopping the manager.
 */
export const KEEP_ONLINE_DEFAULT_MINUTES = 15;
export const KEEP_ONLINE_MIN_MINUTES = 1;
export const KEEP_ONLINE_MAX_MINUTES = 180;

export interface OnlineState {
  readonly enabled: boolean;
  /** How many minutes between attempts. */
  readonly minutes: number;
  /** The address being kept reachable; null only when this is switched off. */
  readonly address: string | null;
  /**
   * Where that address came from.
   *
   * `configured` is somebody having written it down in `STM_PUBLIC_ORIGIN`, or
   * a platform that names itself in the environment. `seen` is the address a
   * browser actually reached this console at - which on a platform that hands
   * out a URL is that URL, learned rather than asked for, the same way the
   * console already knows what to call itself when it offers a link of its
   * own. `local` is this machine's own loopback address, which is what is left
   * when nothing else has been seen.
   */
  readonly source: 'configured' | 'seen' | 'local';
  /**
   * `off` when switched off, `holding` while the address answers,
   * `unreachable` when it stopped.
   */
  readonly status: 'off' | 'holding' | 'unreachable';
  /** When the last attempt was made, or null before there has been one. */
  readonly lastAt: string | null;
  /** Why the last attempt failed, in the words of whatever refused it. */
  readonly error: string | null;
}

/**
 * A published version of the manager itself, as its own release describes it.
 *
 * Not to be confused with `VersionOption`, which is a version of SillyTavern
 * the manager can install. This is the program the reader is looking at, and
 * the only thing anybody can do about it is go and get the new one - so what
 * matters here is not a ref to install but what the release says it changed.
 */
export interface ManagerRelease {
  /** The version the release carries, written the way `package.json` writes it. */
  readonly version: string;
  /** What the release is called, when it is called anything but its tag. */
  readonly name: string | null;
  /**
   * What the release says about itself, as its author wrote it.
   *
   * Plain text, already shortened to something a card can hold. Empty when the
   * release was published without notes, which is a release worth mentioning
   * with nothing to say about it rather than one to hide.
   */
  readonly notes: string;
  /** Where to read the whole of it. */
  readonly url: string;
  readonly publishedAt: string | null;
}

/**
 * Whether a newer manager has been published, and what this one is.
 *
 * `checkedAt` is null before the first answer has come back, which is a
 * different thing from having asked and been told there is nothing: a console
 * that has not heard yet says nothing rather than "you are up to date".
 */
export interface ManagerUpdateStatus {
  /** The version running right now. */
  readonly version: string;
  /** The newer release, or null when this is the newest one there is. */
  readonly update: ManagerRelease | null;
  readonly checkedAt: string | null;
}

export type VersionSelector = 'latest' | 'release' | 'staging' | (string & {});

export type VersionChannel = 'release' | 'staging';

export interface VersionOption {
  readonly selector: VersionSelector;
  readonly label: string;
  readonly ref: string;
  readonly channel: VersionChannel;
  readonly tag: string | null;
  readonly publishedAt: string | null;
}

export type InstallationStatus =
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'health_check'
  | 'ready'
  | 'failed';

export interface Installation {
  readonly id: string;
  readonly selector: VersionSelector;
  readonly resolvedRef: string;
  readonly revision?: string;
  readonly channel: VersionChannel;
  readonly runtimePath: string;
  readonly markerPath: string;
  readonly status: InstallationStatus;
  readonly progress: number;
  /** English step text; `stepCode` is what the panel shows when it has one. */
  readonly step: string;
  readonly stepCode?: string;
  readonly stepParams?: MessageParams;
  readonly error: string | null;
  /**
   * The manager's own code for that failure, when the manager is what failed.
   *
   * `error` is a sentence, and whose sentence it is varies: a refusal the
   * manager wrote, a line git printed, whatever npm said on its way out. The
   * panel translates the first kind and shows the other two as the program
   * that produced them wrote them - translating another project's output makes
   * it impossible to search for. A code is present only for the first kind.
   */
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export type ProfileLayout = 'data' | 'public';

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly installationId: string;
  readonly runtimePath: string;
  readonly configPath: string;
  readonly dataPath: string;
  readonly layout: ProfileLayout;
  /** Set when a legacy public/ tree was copied into the canonical data/ root. */
  readonly legacyLayout?: ProfileLayout | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export type RestoreMode = 'merge' | 'replace';

export type BackupSource = 'created' | 'uploaded';

/**
 * Why an archive exists, which is what a reader sorts a backup library by.
 *
 * `source` only said whether this machine wrote it, so a backup somebody took
 * on purpose, one the schedule took, and the safety copy a restore took were
 * the same row with different suffixes on their names.
 */
export type BackupKind = 'manual' | 'scheduled' | 'before-restore' | 'before-switch' | 'r2' | 'uploaded';

export const BACKUP_KINDS: readonly BackupKind[] = ['manual', 'scheduled', 'before-restore', 'before-switch', 'r2', 'uploaded'];

/**
 * The kind of an archive, including one written before kinds were recorded.
 *
 * Those are read off the suffix their name was given, which is all an older
 * library has; their names are left as they are.
 */
export function backupKind(backup: Pick<BackupManifest, 'kind' | 'name' | 'source'>): BackupKind {
  if (backup.kind) return backup.kind;
  const name = backup.name.replace(/\.zip$/u, '');
  if (/-r2-[^-]/u.test(name)) return 'r2';
  if (backup.source === 'uploaded') return 'uploaded';
  if (name.endsWith('-scheduled')) return 'scheduled';
  if (name.endsWith('-prerestore')) return 'before-restore';
  if (name.endsWith('-preswitch')) return 'before-switch';
  return 'manual';
}

/** The word a default name carries for each kind: short, lower case, no spaces. */
const KIND_SLUG: Record<Exclude<BackupKind, 'uploaded'>, string> = {
  manual: 'manual',
  scheduled: 'auto',
  'before-restore': 'before-restore',
  'before-switch': 'before-switch',
  r2: 'r2',
};

/**
 * A name for an archive nobody named: `Main_auto_2026-09-16_14-30.zip`.
 *
 * Profile, kind, then the date and time in the machine's own clock, so the
 * names sort by time within a kind, read at a glance, and survive as file
 * names on every system a download might land on. The older names ended in a
 * UTC timestamp or an opaque R2 id, which read as noise and sorted by neither.
 */
export function defaultBackupName(profileName: string, kind: Exclude<BackupKind, 'uploaded'>, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}`;
  return `${profileName}_${KIND_SLUG[kind]}_${date}_${time}.zip`;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly layout: ProfileLayout;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly fileCount: number;
  readonly source: BackupSource;
  /** Absent on archives written before kinds were recorded; see `backupKind`. */
  readonly kind?: BackupKind;
  /**
   * The manager chose the name, so the panel may show it in the reader's own
   * language instead. Gone once somebody renames it.
   */
  readonly autoNamed?: boolean;
  readonly fingerprint?: string;
  /** What the reader wrote down about a restore point when they made it. */
  readonly note?: string;
}

/** A connection setting that can come from `.env` instead of the panel. */
export type R2EnvironmentField = 'endpoint' | 'bucket' | 'accessKeyId' | 'secretAccessKey';

/**
 * How often the manager takes a local backup of the active profile.
 *
 * It used to sit in the R2 settings, which made it look like part of R2 and
 * left anyone without a bucket unable to change it, though it ran for them all
 * the same. It is the backup library's setting, and lives there.
 */
export interface LocalBackupSchedule {
  /** Minutes between scheduled backups; `0` means the schedule is off. */
  readonly intervalMinutes: number;
}

/**
 * How the bucket was connected.
 *
 * `keys` is an endpoint, bucket and S3 key pair entered by hand or set in
 * `.env`, which stays available for anyone who does not want to sign in.
 * `cloudflare` is a bucket the manager set up after signing in to Cloudflare.
 */
export type R2ConnectionMode = 'keys' | 'cloudflare';

export type CloudflareConnectionState = 'disconnected' | 'choose_account' | 'connected' | 'reconnect_required';

/**
 * Something about the account itself that stands between it and a backup.
 *
 * `r2_not_enabled` is the one that actually happens: R2 is not part of a
 * Cloudflare account until somebody accepts its terms once in the dashboard,
 * and until they do, a sign-in that granted every permission asked for still
 * cannot make a bucket. Told apart from an ordinary failure because it is the
 * only one the reader fixes in a minute, on a page this can send them to.
 */
export type CloudflareAccountProblem = 'r2_not_enabled';

export interface CloudflareAccountRef {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareConnectionStatus {
  readonly state: CloudflareConnectionState;
  readonly account: CloudflareAccountRef | null;
  readonly bucket: string | null;
  /** Offered while the user has to pick which account backups go to. */
  readonly accounts: readonly CloudflareAccountRef[];
  /** Which way data went last, once anything has; null before the first transfer. */
  readonly dataPath: 'worker' | 'rest' | null;
  /** Why data goes over the slow REST API instead of the Worker, when it does. */
  readonly restReason: 'workers_not_granted' | 'worker_unavailable' | null;
  readonly analyticsGranted: boolean;
  readonly connectedAt: string | null;
  readonly lastError: string | null;
  /** Something about the account that has to be dealt with on Cloudflare, not here. */
  readonly problem: CloudflareAccountProblem | null;
  /**
   * The machine that took this account, when that is why the sign-in is gone.
   *
   * Set when this manager gave its own grant up rather than lost it: another
   * machine signed in with the same Cloudflare account, so this one stopped
   * being allowed to touch it and threw its own credentials away. It is the
   * difference between "sign in again, Cloudflare stopped accepting this" and
   * "sign in again, and you will be taking the account back from that machine".
   */
  readonly displacedBy: string | null;
}

/**
 * What the machine this manager is on does with what is written to it.
 *
 * A console running on somebody's own computer keeps its data because the disk
 * keeps it. A console running on a hosting platform may be on a filesystem that
 * belongs to the container rather than to the account: it is created when the
 * machine starts and thrown away when it stops, and hosts that stop a machine
 * after an idle period stop it with everything in it. The console cannot make
 * that storage durable. What it can do is say so, and offer the one thing that
 * fixes it - a copy somewhere that is not this machine.
 */
export interface StorageDurabilityReport {
  /** Whether what is written here survives this machine being restarted. */
  readonly durable: boolean;
  /** What the data directory is on, when that is what decided it. */
  readonly filesystem: string | null;
  /**
   * How much this machine can vouch for that answer.
   *
   * `durable` is the only one worth staying quiet about: an installation on
   * somebody's own computer, writing to a filesystem that is plainly a disk.
   *
   * `temporary` is a filesystem that is known to be thrown away with the
   * machine. `unverified` is everything else - a container, a hosted
   * workspace, anything this manager cannot place - and it is the answer the
   * console gives about infrastructure it has never heard of, which is all of
   * it. Saying "this may not be kept" about a machine that keeps it costs a
   * sentence; saying nothing about one that does not costs somebody their
   * chats.
   */
  readonly assurance: StorageAssurance;
  /** What the machine calls itself, so the warning can name it. */
  readonly machine?: string;
}

export type StorageAssurance = 'durable' | 'unverified' | 'temporary';

export interface R2Config {
  readonly mode: R2ConnectionMode;
  /** Null when this manager has no Cloudflare OAuth client configured. */
  readonly cloudflare: CloudflareConnectionStatus | null;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  /** Set in `.env`, so the panel shows them and cannot change them. */
  readonly environmentFields: readonly R2EnvironmentField[];
  readonly configured: boolean;
  readonly lastUploadAt: string | null;
  readonly accessKeyIdMasked: string | null;
  readonly secretAccessKeyConfigured: boolean;
  readonly schedule: {
    /**
     * How often the small, precious part of the profile is sent: chats,
     * settings, worlds and character cards. Only changed chunks go, so this can
     * be minutes rather than a day.
     */
    readonly hotIntervalMinutes: number;
    /** How often everything else goes - images and attachments, large and rarely touched. */
    readonly coldIntervalHours: number;
    /** How often a listing replaces what the manager believes the bucket holds. */
    readonly reconcileIntervalHours: number;
  };
  /**
   * How many recovery points survive, oldest thinned first.
   *
   * Snapshots share every chunk they have in common, so keeping more of them
   * costs the changes between them rather than a copy each.
   */
  readonly retention: {
    readonly keepRecent: number;
    readonly keepDaily: number;
    readonly keepWeekly: number;
  };
  /** What the manager refuses to exceed, so a free account stays a free account. */
  readonly limits: {
    readonly maxStorageBytes: number;
    readonly maxWriteOperations: number;
    /**
     * Reads are reported against this but never refused because of it.
     *
     * The reads are a restore. Refusing to give someone their data back to
     * avoid a small bill is the wrong trade, and the ceiling that would do it
     * is worse than the bill.
     */
    readonly maxReadOperations: number;
  };
  readonly usage: R2Usage;
  readonly lastFingerprint: string | null;
  /**
   * The recovery point the manager brought back on its own, if it ever did.
   *
   * A machine that does not keep its disk restores itself on the way up, before
   * anybody opens the console. That is the whole point of putting the bucket in
   * `.env` - but done silently it is indistinguishable from a machine that
   * happened to still have the data, and the reader has no way to tell whether
   * what they are looking at is yesterday's work or a fresh installation that
   * looks like it. So it is written down and said.
   */
  readonly lastRecovery: {
    readonly at: string;
    /** When the point that came back was taken. */
    readonly createdAt: string;
    readonly fileCount: number;
    /**
     * How much came back, which is what the card says.
     *
     * A file count answers a question nobody asked: 790 files is not a size,
     * not a duration, and not something a reader can weigh against what they
     * remember having. Absent on a recovery recorded before this was kept.
     */
    readonly sizeBytes?: number;
  } | null;
  /**
   * Which installation is backing up to this bucket, as last read from it.
   *
   * One account, one manager. Two of them share a bucket without ever seeing
   * each other - they write under different profile ids - while the sweep that
   * collects chunks nothing points at is a whole-bucket operation and would
   * run against whatever the other one had uploaded but not yet indexed. So
   * the bucket carries a claim, and a manager that is not the one named in it
   * stops and says so here instead.
   *
   * Null when nothing has been read yet, when the bucket was connected with
   * manual keys - somebody carrying their own credentials between machines is
   * doing it on purpose - or on an older manager's answer.
   */
  readonly owner?: {
    /** What the holding machine calls itself, usually its hostname. */
    readonly label: string;
    readonly lastSeenAt: string;
    /** Whether the holder is this manager. */
    readonly mine: boolean;
  } | null;
}

export interface R2OperationCounts {
  readonly classA: number;
  readonly classB: number;
  readonly free: number;
  /** Action types Cloudflare's pricing page does not list. Shown, not guessed into a class. */
  readonly unclassified: number;
}

export interface R2UsageScope {
  /** Object data plus metadata at the latest sample; null when Cloudflare had none. */
  readonly storageBytes: number | null;
  readonly objectCount: number | null;
  readonly measuredAt: string | null;
  /** Month to date, from the start of the calendar month in UTC. */
  readonly operations: R2OperationCounts;
}

export interface R2UsageWarning {
  /**
   * `account` is measured against Cloudflare's free tier, which the whole
   * account shares; `bucket` against the ceilings set in the manager.
   */
  readonly scope: 'account' | 'bucket';
  readonly metric: 'storage' | 'classA' | 'classB';
  readonly used: number;
  readonly limit: number;
}

/**
 * What Cloudflare's analytics say a signed-in bucket and its account used.
 *
 * Usage, not billing. There is no API for the bill or for what is left of the
 * free tier; a billing period need not start on the first of the month; storage
 * is billed as an average over the month while this is the size now; and the
 * figures lag by some minutes. Warnings are early signs, not a statement of cost.
 */
export interface R2CloudflareUsage {
  readonly fetchedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bucket: R2UsageScope & { readonly name: string };
  readonly account: R2UsageScope;
  readonly freeTier: { readonly storageBytes: number; readonly classA: number; readonly classB: number };
  readonly warnings: readonly R2UsageWarning[];
}

export interface R2UsageResponse {
  readonly usage: R2CloudflareUsage | null;
  /** Why there are no figures from Cloudflare, when there are none. */
  readonly unavailable: 'keys_mode' | 'not_connected' | 'analytics_not_granted' | 'query_failed' | null;
  readonly error: string | null;
}

export interface R2Usage {
  readonly storageBytes: number;
  readonly blobCount: number;
  readonly snapshotCount: number;
  /** Charged writes and listings this calendar month, counted locally. */
  readonly writeOperations: number;
  /** Charged reads this calendar month. A restore is roughly one per file. */
  readonly readOperations: number;
  readonly periodStartedAt: string;
  /** Archives left in the bucket by the version that uploaded whole ZIP files. */
  readonly legacyObjectCount: number;
  readonly legacyBytes: number;
  readonly lastReconciledAt: string | null;
  /**
   * When a manager first counted operations against this bucket.
   *
   * The count is kept in the bucket, so it starts at zero the first time an
   * account is connected and then survives the machine: a reinstall, a new
   * computer, or a hosted studio that starts each time from nothing all read
   * back the month that is actually being billed. Absent until a bucket has
   * been read, and on a manager too old to keep the record.
   */
  readonly countingSince?: string;
  /**
   * Whether the two figures above come from that shared record rather than
   * from this machine's own memory of what it has done.
   */
  readonly sharedRecord?: boolean;
}

/**
 * A size in the units the thing being measured is actually sold in.
 *
 * Cloudflare quotes a bucket in GB and gives away 10 of them, decimal, and
 * network rates are decimal everywhere. Dividing by 1024 and writing "GB"
 * understates a bucket by seven percent - enough that the panel and the
 * Cloudflare dashboard disagreed about the same bucket and neither looked
 * wrong. One function, so they cannot disagree again.
 */
export function formatBytes(value: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
  return `${unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/**
 * How far a transfer has got, in bytes as well as in things.
 *
 * A count of files says nothing about how long is left when the files are a
 * settings file and a twenty megabyte character card. Bytes are what the wait
 * is actually made of.
 */
export interface TransferProgress {
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly completedItems: number;
  readonly totalItems: number;
}

/** One recovery point in the bucket, as a listing can describe it without reading it. */
export interface R2SnapshotSummary {
  readonly id: string;
  readonly profileId: string;
  readonly createdAt: string;
  /** The index object alone, which is not what bringing the point back costs. */
  readonly indexBytes: number;
  /** Files the point names, or null for a point written before this was recorded. */
  readonly fileCount: number | null;
  /** The data those files hold: what bringing the point back downloads. */
  readonly dataBytes: number | null;
}

/**
 * What one look at the bucket found, so the answer can be shown rather than flashed.
 *
 * The panel used to offer three buttons that all did some of this - "Test
 * connection", "Check the bucket", "Refresh" - and each answered with a toast
 * that said it had worked and then went away. Three buttons, one question, and
 * no lasting answer to it. This is the one question: is the bucket reachable,
 * and what is in it. Its answer stays on the card.
 *
 * `failure` rides inside a successful response on purpose: an unreachable
 * bucket is a finding, not a broken request, and it belongs on the card beside
 * the figures it replaces.
 */
export interface R2CheckResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  /** The bucket that answered, named as the reader knows it. */
  readonly bucket: string | null;
  readonly objectCount: number;
  readonly totalBytes: number;
  readonly snapshotCount: number;
  /** Archives left by the version that uploaded whole ZIP files, which nothing reads. */
  readonly legacyObjectCount: number;
  readonly legacyBytes: number;
  /** The manager's own counters, brought back in line with what was listed. */
  readonly usage: R2Usage | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface R2Object {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

export interface BackupFilePreview {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface RestorePreview {
  readonly layout: ProfileLayout;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly BackupFilePreview[];
  /**
   * What is worth knowing before restoring, as catalogued events.
   *
   * These were English sentences written by the server and printed into the
   * restore dialog exactly as they arrived, so a reader who had the rest of
   * the console in Vietnamese met one paragraph of English at the one moment
   * that cannot be undone.
   */
  readonly warnings: readonly LogEvent[];
  /**
   * Whether this archive is a SillyTavern profile at all.
   *
   * A zip reaches the manager because a person handed it over, and people hand
   * over the wrong file: an installer, a character card, a folder of holiday
   * photos. Nothing checked, so the wrong file restored - a replace emptied
   * the profile of everything the archive did not mention, and the run
   * reported success. Restoring one of these is now refused unless the reader
   * says in the dialog that they meant it.
   *
   * Absent on an older manager's answer, which is read as recognised: there
   * was nothing else it could have meant.
   */
  readonly recognized?: boolean;
  /**
   * Where inside the archive the profile starts; `''` when it is at the root.
   *
   * A zip of `data/default-user/`, or of the folder rather than its contents,
   * is a profile one or two directories down. Carried so the panel can say
   * which part of the archive is going to be read.
   */
  readonly root?: string;
  /**
   * Whether the restore fits on this machine; saver mode only.
   *
   * A host with a few gigabytes for memory and disk together keeps written
   * files in the same memory the programs run in, so a restore larger than
   * what is left takes the machine down part way through. One answer per
   * mode, because a replace frees what it deletes and a merge only what it
   * overwrites.
   */
  readonly capacity?: Readonly<Record<RestoreMode, RestoreCapacity>>;
}

/**
 * How much a restore adds to this machine, against how much room it has.
 *
 * "Junk" is what SillyTavern or an extension can do without or make again:
 * extensions' git history and `node_modules`, SillyTavern's own `backups/`,
 * `thumbnails/`, `vectors/` and caches. Leaving it out restores every chat,
 * character, lorebook, preset and setting.
 */
export interface RestoreCapacity {
  /** Room left for the restore, with what SillyTavern needs to run held back. */
  readonly availableBytes: number;
  /** What the restore adds, net of the files a replace deletes. */
  readonly neededBytes: number;
  /** The same, leaving the junk out. */
  readonly trimmedNeededBytes: number;
  readonly junkBytes: number;
  readonly junkFiles: number;
  readonly fits: boolean;
  readonly fitsTrimmed: boolean;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * What a job is doing, in the reader's terms rather than in its result's.
 *
 * Sending to R2 and bringing a recovery point back were both filed as
 * `backup`, because a fetch does end with an archive in the library. A panel
 * that came back to a job it had not started - a tab switched away from and
 * returned to - had only this to name it by, so a download of a gigabyte
 * announced itself as "Back up now" in the local backup card while the cloud
 * card, which had started it, showed nothing.
 */
export type JobKind = 'installation' | 'backup' | 'restore' | 'r2Upload' | 'r2Fetch';

/** The jobs a panel reattaches to and shows progress for; an install is its own screen. */
export const OPERATION_JOB_KINDS: readonly JobKind[] = ['backup', 'restore', 'r2Upload', 'r2Fetch'];

/** Whether this job belongs to the cloud card rather than the local backup card. */
export function isCloudJob(kind: JobKind): boolean {
  return kind === 'r2Upload' || kind === 'r2Fetch';
}

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly progress: number;
  /** English step text; `stepCode` is what the panel shows when it has one. */
  readonly step: string;
  readonly stepCode?: string;
  readonly stepParams?: MessageParams;
  readonly installationId: string | null;
  /**
   * The archive a finished job produced, when it produced one.
   *
   * Set by fetching a recovery point out of R2: what arrives is an ordinary
   * backup, and the panel opens the same restore question over it that an
   * uploaded zip gets. Without this the panel would have to guess which of the
   * archives in the library was the one it just asked for.
   */
  readonly resultBackupId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

/** Values substituted into a translated log line or progress step. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * A line the manager wrote itself, carrying both its English text and the
 * catalog key the panel translates it with.
 *
 * Output produced by another program - SillyTavern, cloudflared, npm, git - is
 * passed through as a plain string and shown exactly as it was written. Only
 * what this project authors is translated.
 */
export interface LogEvent {
  readonly code: string;
  readonly message: string;
  readonly params?: MessageParams;
}

export type LogLine = string | LogEvent;

/** Where a component sends its output; the manager decides what to do with it. */
export type LogSink = (line: LogLine) => void;

export function logEvent(code: string, message: string, params?: MessageParams): LogEvent {
  return params === undefined ? { code, message } : { code, message, params };
}

export function isLogEvent(line: LogLine): line is LogEvent {
  return typeof line === 'object' && line !== null;
}

export function logLineText(line: LogLine): string {
  return isLogEvent(line) ? line.message : line;
}

export interface LogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly source: 'manager' | 'sillytavern' | 'cloudflared' | 'installer' | 'backup';
  readonly level: 'info' | 'warn' | 'error';
  /** English rendering. Always present, and what the durable log file keeps. */
  readonly message: string;
  /** Catalog key under `logs.`, absent for third-party output. */
  readonly code?: string;
  readonly params?: MessageParams;
}

export type LogSourceFilter = LogEntry['source'] | 'all';

export type ProcessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ProcessState {
  readonly status: ProcessStatus;
  readonly installationId: string | null;
  readonly profileId: string | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly error: string | null;
  /** Set when the manager is what failed; see `Installation.errorCode`. */
  readonly errorCode?: string;
  /**
   * What a start or a stop is doing right now, as a `logs.process.*` code.
   *
   * Read off SillyTavern's own output while it starts - compiling the
   * frontend, loading plugins, opening the port - so the console can say
   * which of those it is waiting on instead of one sentence for all of them.
   * Only present while the state is `starting` or `stopping`.
   */
  readonly stepCode?: string;
  readonly stepParams?: MessageParams;
}

/**
 * Why the manager asked a process it owns to stop.
 *
 * A stop looks identical from the outside whether the operator pressed Stop,
 * a restore needed the data held still, or a different version was being
 * installed - the exit code is null in every one of those cases. Recording the
 * reason at the point the stop is requested is the only place that knows.
 */
export type StopReason =
  | 'requested'
  | 'restart'
  | 'install'
  | 'uninstall'
  | 'restore'
  | 'profileSwitch'
  | 'configChange'
  | 'passwordChange'
  | 'shutdown'
  | 'startupFailed';

export const STOP_REASON_TEXT: Readonly<Record<StopReason, string>> = {
  requested: 'you asked it to stop',
  restart: 'restarting it',
  install: 'installing a different SillyTavern version',
  uninstall: 'removing SillyTavern',
  restore: 'restoring a backup',
  profileSwitch: 'switching profile',
  configChange: 'applying a configuration change',
  passwordChange: 'applying the new SillyTavern password',
  shutdown: 'the manager is shutting down',
  startupFailed: 'it did not finish starting',
};

/** The catalog key for a stop reason, for example `stoppedRequested`. */
export function stopReasonCode(reason: StopReason): string {
  return `stopped${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
}

/** How a process that nobody asked to stop went away. */
export function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  return code === null ? 'no exit code' : `exit code ${code}`;
}

export type TunnelMode = 'off' | 'quick' | 'named';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface TunnelState {
  readonly mode: TunnelMode;
  readonly status: TunnelStatus;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly error: string | null;
  /**
   * A fixed address in front of this tunnel, when there is one.
   *
   * A Quick Tunnel's own address is random and is a different one every time
   * cloudflared starts, so it cannot be the address anybody keeps: a bookmark
   * from yesterday answers `DNS_PROBE_FINISHED_NXDOMAIN`, because the hostname
   * has gone from DNS rather than merely stopped answering. Given a Cloudflare
   * sign-in, the manager puts a Worker on the account's own `workers.dev`
   * subdomain and redeploys it at each new tunnel, so this address stays the
   * same. It is the one to show and the one to share; `url` above is still the
   * truth about where the traffic actually goes, and is worth showing beside it.
   *
   * Absent where nothing decorates the state - the tunnel manager itself does
   * not know about any of this - and null when no Worker is deployed.
   */
  readonly proxyUrl?: string | null;
  /**
   * Whether the fixed address above is on its way but not usable yet.
   *
   * Deploying a Worker is a write to somebody's Cloudflare account over the
   * network, and it takes seconds; the tunnel announces its own address long
   * before that finishes. In between, there are two ways to be wrong. On a
   * first run there is no Worker yet, so the console showed the tunnel's own
   * address and then swapped it for the permanent one a moment later - which
   * is the address somebody had already copied. On every run after that the
   * Worker exists but is still pointing at the tunnel from last time, so it is
   * a deployed address that answers with an error.
   *
   * True covers both: a fixed address is expected here, and what there is now
   * is not it. A console reading this shows the link as still coming rather
   * than offering something it will take back.
   *
   * Absent where nothing decorates the state, like `proxyUrl` above.
   */
  readonly proxyPending?: boolean;
}

/**
 * What SillyTavern's configuration says, and the part of it worth offering.
 *
 * The first group is reported and never written: the manager owns those, and
 * the console shows them so it is clear why they cannot be moved. SillyTavern
 * stays on the loopback address behind the access gateway, on port 8000, with
 * its own two password mechanisms off because the gateway replaces both.
 *
 * The second group is what somebody running SillyTavern actually reaches for.
 * They are not the settings this page used to offer - HTTPS, the CORS proxy
 * and switching CSRF protection off. Under the manager the first of those
 * breaks the gateway, which speaks plain HTTP to the loopback address and is
 * behind Cloudflare's TLS already; the last has nothing to gain and a name
 * that ends in "NOT RECOMMENDED" in SillyTavern's own file. Anyone who really
 * wants one of them still has config.yaml.
 */
export interface ConfigSettings {
  readonly listen: boolean;
  readonly listenAddress: {
    readonly ipv4: string;
    readonly ipv6: string;
  };
  readonly whitelistMode: boolean;
  readonly port: number;
  readonly enableUserAccounts: boolean;
  readonly basicAuthMode: boolean;
  readonly sslEnabled: boolean;
  readonly enableCorsProxy: boolean;
  readonly disableCsrfProtection: boolean;
  /** Parse character cards on demand rather than all at once. */
  readonly lazyLoadCharacters: boolean;
  /** Keep parsed cards on disk between runs. */
  readonly useDiskCache: boolean;
  /** How much memory parsed cards may use, as SillyTavern writes it: `100mb`. */
  readonly memoryCacheCapacity: string;
  /** Compress large uploads - the one that matters over a tunnel. */
  readonly requestCompression: boolean;
  readonly extensions: boolean;
  readonly extensionAutoUpdate: boolean;
  /** Whether a stored provider key can be read back out of SillyTavern. */
  readonly allowKeysExposure: boolean;
  /** SillyTavern's own per-chat backups, which the manager then backs up too. */
  readonly chatBackups: boolean;
  readonly chatBackupCount: number;
}

/** The settings the console may write. Everything else is read-only or YAML. */
export type ConfigSettingsInput = Partial<Pick<ConfigSettings,
  | 'lazyLoadCharacters'
  | 'useDiskCache'
  | 'memoryCacheCapacity'
  | 'requestCompression'
  | 'extensions'
  | 'extensionAutoUpdate'
  | 'allowKeysExposure'
  | 'chatBackups'
  | 'chatBackupCount'
>>;

export interface ConfigDocument {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly runtimeRef: string;
  readonly runtimeRevision?: string;
  readonly path: string;
  readonly format: 'yaml' | 'yml';
  /** First non-loopback IPv4 address found on the manager host, for LAN setup. */
  readonly networkHost?: string;
  /** YAML retains Basic Auth keys; any custom Basic Auth password is masked. */
  readonly rawYaml: string;
  readonly settings: ConfigSettings;
  readonly restartRequired: boolean;
}

export interface ConfigUpdateInput {
  readonly rawYaml?: string;
  readonly settings?: ConfigSettingsInput;
}

export type AccessGatewayStatus = 'stopped' | 'running' | 'error';

/**
 * The guarded door in front of SillyTavern.
 *
 * SillyTavern stays bound to the loopback address on every version, and this is
 * the listener that anything else reaches: it asks for a password once, keeps a
 * session, and passes the rest through. It replaces both of the mechanisms
 * SillyTavern itself offers - Basic Auth, a browser dialog with no way to sign
 * out and nothing the manager can present, and user accounts, which only exist
 * from 1.12 on and so left every older version with no password at all.
 */
export interface AccessGatewayState {
  readonly status: AccessGatewayStatus;
  /** The bound address, or null while it is not listening. */
  readonly host: string | null;
  readonly port: number;
  /** Whether it is reachable from the local network rather than this machine. */
  readonly lan: boolean;
  /**
   * This machine's own address on the network around it, when it has one.
   *
   * The address the LAN door answers at, and so the one the console shows
   * beside that switch. Null on a machine with no network of its own - a
   * hosted container has no Wi-Fi for another device to share - and there the
   * switch is not offered at all, rather than opening a door onto nothing.
   *
   * It rides on this state rather than on the configuration document, which
   * also carries it: that document does not exist until SillyTavern is
   * installed, and the switch is on screen well before then.
   *
   * Additive: absent where nothing decorates the state, which is every
   * caller inside the gateway itself.
   */
  readonly networkHost?: string | null;
  readonly passwordConfigured: boolean;
  /**
   * Whether that credential is a six-digit passcode rather than a password.
   *
   * The public sign-in page needs to know which of the two to ask for, and it
   * only ever sees the hash. A door set up before passcodes existed keeps the
   * field it was set up with rather than locking its owner out.
   */
  readonly passcode: boolean;
  /**
   * How many browsers hold a session through this door right now.
   *
   * The settings page offers to end all of them at once, and a count is what
   * makes that offer mean something: it is the difference between "sign out
   * every device" and "sign out the three devices that are signed in".
   */
  readonly sessions: number;
  readonly error: string | null;
}

/**
 * What the manager itself is set to, kept in the bucket beside the data.
 *
 * The bucket has always held SillyTavern's data and nothing about the manager
 * running it, so somebody who lost a machine got their chats back and then set
 * everything up again by hand: the password on the console, the passcode that
 * opens SillyTavern from a phone, how often to back up, how much of the free
 * allowance to use, which release to install. None of that is large and all of
 * it is the difference between "my data is back" and "I am back".
 *
 * The two password fields are the scrypt hashes the manager stores, never a
 * password. They are in the bucket for the same reason the chats are: it is
 * the reader's own account, reached with the reader's own credential, and a
 * hash that comes back is what lets the door they already know still open.
 *
 * Nothing here is ever applied on its own. A manager that finds this offers it
 * and says which machine wrote it and when; changing the password on a console
 * because a bucket said so is not something to do while nobody is watching.
 */
export interface ManagerSettingsRecord {
  readonly schemaVersion: 1;
  /** The machine these came from, as the bucket's claim names it. */
  readonly label: string;
  /**
   * The installation that wrote them, so it can recognise its own.
   *
   * A hostname cannot do this job: two machines share one, and one machine
   * that is wiped and set up again keeps it. Without this the console offered
   * a machine its own settings back, minutes after it had written them -
   * which reads as somebody else being on the account.
   *
   * Null on a record written before this field existed.
   */
  readonly installId: string | null;
  readonly writtenAt: string;
  /** The console's own password, as a hash. Null when none is set yet. */
  readonly adminPasswordHash: string | null;
  /** The credential in front of SillyTavern, as a hash. */
  readonly accessPasswordHash: string | null;
  /** Whether that credential is a six-digit passcode rather than a password. */
  readonly accessPasscode: boolean;
  /** Whether the door in front of SillyTavern answers on the local network. */
  readonly accessLanEnabled: boolean;
  /**
   * Whether a Quick Tunnel was open in front of SillyTavern, and in front of
   * the console.
   *
   * The quick kind only. A Named Tunnel is started with a token, which is a
   * live credential and has no business being in a bucket, so a machine
   * putting itself back together is left with that one off rather than with
   * one it cannot start. Without these two, a machine that had been reached
   * from a phone came back reachable from nothing, with the passcode restored
   * and no door for it to open - which looked exactly like the restore having
   * done nothing.
   */
  readonly tunnelQuick: boolean;
  readonly managerTunnelQuick: boolean;
  readonly autoStartSillyTavern: boolean;
  /**
   * Whether the machine kept itself online, and how often it checked.
   *
   * Part of how a machine was set up rather than a fact about it: somebody who
   * turned this off did so on purpose, and somebody who moved it to five
   * minutes did so because the machine they run on goes quiet sooner than the
   * default expects. A machine put back together without them came back
   * checking every quarter of an hour whatever the reader had chosen.
   *
   * Defaulted rather than optional on a record written before these existed,
   * which is a record from a manager that did this at all.
   */
  readonly keepOnline: boolean;
  readonly keepOnlineMinutes: number;
  readonly sillyTavernPort: number;
  /** How often a ZIP is taken on the machine; 0 is off. */
  readonly localIntervalMinutes: number;
  readonly r2: {
    readonly hotIntervalMinutes: number;
    readonly coldIntervalHours: number;
    readonly reconcileIntervalHours: number;
    readonly keepRecent: number;
    readonly keepDaily: number;
    readonly keepWeekly: number;
    readonly maxStorageBytes: number;
    readonly maxWriteOperations: number;
    readonly maxReadOperations: number;
  };
  /** Which SillyTavern the machine was told to run, so a new one matches it. */
  readonly versionSelector: string | null;
  /**
   * The release that was actually running, resolved.
   *
   * `versionSelector` is what the reader picked, and "latest" is not a
   * version: a machine put back together from it a month later gets whatever
   * is newest that day, which is not the SillyTavern their data was written
   * by. This is the tag `latest` had resolved to - or `release`/`staging`
   * where that is what was chosen, which resolve to themselves - so a
   * recovered machine comes back running the same build it lost.
   */
  readonly versionRef: string | null;
}

/** What the panel is told about settings waiting in the bucket. */
export interface ManagerSettingsOffer {
  readonly available: boolean;
  readonly label: string | null;
  readonly writtenAt: string | null;
  /** Whether it was this installation that wrote them. */
  readonly mine: boolean;
  /** Whether it carries a console password, which replacing is worth saying. */
  readonly hasAdminPassword: boolean;
  readonly hasAccessPassword: boolean;
}

/**
 * Everything the console watches continuously, in one answer.
 *
 * They used to be separate requests on separate timers, which is several times
 * the traffic for one screenful of state - and through a Cloudflare Worker,
 * where the console's own address is a Worker and every request is charged
 * against a daily allowance, several times the bill. Nothing here is computed:
 * each field is what its own endpoint returns, which still exists and still
 * answers.
 *
 * The fields below `r2Problem` are the ones a caller asks for by name, because
 * they are the expensive halves: a machine reading nobody is looking at, a
 * log nobody has opened, an archive list that has not changed since the last
 * answer. See `ConsoleStatusSections`.
 */
export interface ConsoleStatus {
  readonly process: ProcessState;
  readonly tunnel: TunnelState;
  readonly managerTunnel: TunnelState;
  readonly security: AccessGatewayState;
  /**
   * Work the manager started by itself, for a panel that did not start it.
   *
   * A console asks about these once when it loads, which is only ever right by
   * luck: a manager set up with a Cloudflare account begins installing and
   * downloading seconds *after* the redirect lands, so the one question the
   * page asked had already been answered "nothing is running" - and the reader
   * sat in front of an empty Overview for the several minutes it took, with
   * one line in the log to go on. They are in this answer because this is the
   * one the console asks on a clock.
   */
  readonly install: Job | null;
  readonly operation: Job | null;
  /**
   * Which ports this manager holds, including the one SillyTavern is on.
   *
   * Here because the console used to ask once, as it loaded, and the port is
   * one of the things a restore moves: a machine brought back from the bucket
   * started SillyTavern on the port the bucket remembered - 8004, say - while
   * the settings page went on showing the default it had read at load, until
   * somebody reloaded the page. Read from memory, so it costs this answer
   * nothing.
   */
  readonly ports: PortSettings;
  /**
   * Which machine is backing up to the Cloudflare account, if one is.
   *
   * Here for the same reason the ports are. The console used to ask this once,
   * as it opened, down the one route that goes and reads the bucket - so a
   * console that was already open when somebody signed in on another machine
   * showed nothing at all. It went on showing a backup card that had stopped
   * being true until the page happened to be reloaded, which is exactly the
   * moment a reader is least likely to reload it. Read from memory, so it
   * costs this answer nothing.
   */
  readonly r2Owner: R2Config['owner'];
  /**
   * Something about the signed-in Cloudflare account that has to be fixed on
   * Cloudflare before any of this works.
   *
   * Here for the same reason the claim is: it is the whole of what a manager
   * can do about backups, and it was said only inside the form where the
   * account was chosen - a form nobody opens again once it is closed. A
   * machine whose account has never turned R2 on is backing nothing up, on
   * every page, and should say so on every page.
   */
  readonly r2Problem: CloudflareAccountProblem | null;
  /**
   * What this machine is doing, when the caller says it is showing it.
   *
   * Left out otherwise. These are three live meters, and a meter nobody is
   * looking at is worth nothing while still costing a reading of the clock,
   * a `statfs` and its share of the answer.
   */
  readonly system?: SystemSnapshot;
  /** New log lines since `logsAfter`, when the caller asked to follow the log. */
  readonly logs?: LogPage;
  /**
   * The archive list, sent only when it is not the one the caller already has.
   *
   * The list is read from memory and costs the machine nothing, but it is the
   * one section here that grows: a hundred recovery points is kilobytes on
   * every answer, forever, to say what the last answer said. So the caller
   * sends back the tag it was given and is sent the list only when that tag is
   * stale. An unchanged list costs the twenty-odd bytes of `backupsTag`.
   */
  readonly backups?: readonly BackupManifest[];
  /** The tag naming the current archive list, whenever backups were asked for. */
  readonly backupsTag?: string;
  /**
   * Ask less often than the screen would otherwise call for.
   *
   * Set while the account's Cloudflare Worker allowance for the day is running
   * down. Every request the console makes through its own fixed address is one
   * of that allowance, shared with SillyTavern's address and with the backup
   * Worker, and this is the first and cheapest thing given up: a slower screen
   * costs nobody an address. Absent, which is the ordinary case, means ask at
   * whatever pace the screen calls for.
   */
  readonly easePolling?: boolean;
}

/** New log lines and the cursor to ask from next time. */
export interface LogPage {
  readonly streamId: string;
  readonly entries: readonly LogEntry[];
  readonly nextCursor: number;
}

/**
 * The parts of `ConsoleStatus` a caller has to ask for, named in `include`.
 *
 * Asked for rather than always sent, because what is worth the cost depends on
 * what is on the reader's screen and only the console knows that.
 */
export const CONSOLE_STATUS_SECTIONS = ['system', 'logs', 'backups'] as const;
export type ConsoleStatusSection = (typeof CONSOLE_STATUS_SECTIONS)[number];

export function isConsoleStatusSection(value: string): value is ConsoleStatusSection {
  return (CONSOLE_STATUS_SECTIONS as readonly string[]).includes(value);
}

/** The complete allowlist written by the SillyTavern fetch instrumentation. */
export interface UsageEvent {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly provider: string;
  /** The completion API format observed on the route (for example google or openai). */
  readonly completionSource?: string | null;
  readonly model: string | null;
  readonly endpointHost: string | null;
  readonly stream: boolean;
  readonly maxTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly status: number | null;
  readonly durationMs: number;
}

export interface MetricsTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  /** Input tokens covered by a provider's cache accounting. */
  readonly cacheEligibleInputTokens: number;
  /** Requests that returned cache read/write metadata. */
  readonly cacheObservedRequests: number;
  /** cacheReadTokens / cacheEligibleInputTokens, or null when unavailable. */
  readonly cacheHitRate: number | null;
  readonly streamRequests: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly averageLatencyMs: number;
}

export interface MetricsBucket extends MetricsTotals {
  readonly key: string;
  readonly provider?: string;
  readonly model?: string;
  readonly completionSource?: string | null;
}

/** Host readings for the status panel. Null means the platform would not answer. */
export interface SystemSnapshot {
  readonly generatedAt: string;
  readonly cpu: {
    readonly cores: number;
    /** Share of CPU time out of idle since the previous reading. */
    readonly usagePercent: number | null;
  };
  readonly memory: {
    readonly totalBytes: number;
    readonly freeBytes: number;
    readonly usedBytes: number;
  };
  readonly storage: {
    readonly root: string;
    /**
     * Files here are held in the memory above, so there is no disk to report.
     *
     * A container like that is still asked about a disk by `statfs`, and
     * answers with the host's: hundreds of gigabytes it cannot use. The two
     * sizes below are null then rather than that.
     */
    readonly inMemory: boolean;
    readonly totalBytes: number | null;
    readonly freeBytes: number | null;
    /** Everything the manager keeps, archives and profiles included. */
    readonly managerBytes: number | null;
    /** The active profile's user data, which is what SillyTavern reads. */
    readonly dataBytes: number | null;
    readonly dataFileCount: number | null;
    /** When the directory sizes were last walked, or null before the first walk. */
    readonly measuredAt: string | null;
    /** True while a walk is in flight, so the panel can say so. */
    readonly measuring: boolean;
  };
}

export interface MetricsSnapshot {
  readonly generatedAt: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly totals: MetricsTotals;
  readonly daily: readonly MetricsBucket[];
  readonly providers: readonly MetricsBucket[];
  readonly models: readonly MetricsBucket[];
  /** How much the manager itself was used, which the counts above cannot say. */
  readonly appUsage?: AppUsageSummary;
}

/**
 * How long the manager was actually used on one day.
 *
 * Counting requests to an AI provider says how much somebody chatted; it says
 * nothing about a manager that is installed and never opened, or one that is
 * left running for a week while SillyTavern is off. Three numbers separate
 * those: how long the manager ran, how long it kept SillyTavern up, and how
 * long somebody actually had the console in front of them.
 *
 * The third is measured from requests the console already makes rather than
 * from anything it is asked to send - and because those stop while the page is
 * hidden, it counts a console being looked at rather than a tab left open.
 *
 * There is nothing here about what was done, only for how long, and a day is
 * the finest grain: the point is to know whether the thing gets used, not when
 * somebody is at their desk.
 */
export interface AppUsageDay {
  readonly schemaVersion: 1;
  /** The calendar day in UTC, `YYYY-MM-DD`. */
  readonly date: string;
  /** How long the manager process was running. */
  readonly managerSeconds: number;
  /** How long SillyTavern was up under it. */
  readonly sillyTavernSeconds: number;
  /** How long somebody had the console open and in front of them. */
  readonly consoleSeconds: number;
  /** How many times the manager was started that day. */
  readonly starts: number;
}

/** What the panel shows about how much the manager itself is used. */
export interface AppUsageSummary {
  readonly days: readonly AppUsageDay[];
  readonly totals: Omit<AppUsageDay, 'schemaVersion' | 'date'>;
}

/** A privacy-filtered batch queued for the future telemetry endpoint. */
export interface TelemetryBatch {
  readonly schemaVersion: 1;
  readonly installId: string;
  readonly appVersion: string;
  readonly platform: PlatformKind;
  readonly sentAt: string;
  readonly events: readonly UsageEvent[];
  /**
   * Finished days of manager usage, when there are any.
   *
   * Additive: absent unless a day has closed since the last batch, so a batch
   * of provider events is exactly what it has always been.
   */
  readonly usageDays?: readonly AppUsageDay[];
}

/** Transport envelope signed by the installation-specific telemetry key. */
export interface TelemetryEnvelope {
  readonly schemaVersion: 1;
  readonly installId: string;
  readonly sentAt: string;
  readonly nonce: string;
  readonly signature: string;
  readonly batch: TelemetryBatch;
}
