export type PlatformKind = 'windows' | 'linux' | 'termux' | 'docker' | 'modelscope' | 'unknown';

export interface ManagerPorts {
  readonly manager: 7860;
  readonly sillyTavern: 8000;
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
  readonly setupCodeRequired: boolean;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  readonly notice: {
    readonly telemetry: string;
    readonly terms: string;
    readonly disclaimer: string;
  };
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly manager: {
    readonly version: string;
    readonly port: 7860;
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
  readonly step: string;
  readonly error: string | null;
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

export interface ProfileSnapshot {
  readonly id: string;
  readonly profileId: string;
  readonly createdAt: string;
  readonly path: string;
  readonly fingerprint?: string;
}

export type RestoreMode = 'merge' | 'replace';

export type BackupSource = 'created' | 'uploaded';

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
  readonly includesSecrets: boolean;
  readonly fileCount: number;
  readonly source: BackupSource;
  readonly fingerprint?: string;
}

export interface R2Config {
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  readonly accountId: string | null;
  readonly configured: boolean;
  readonly lastUploadAt: string | null;
  readonly accessKeyIdMasked: string | null;
  readonly secretAccessKeyConfigured: boolean;
  readonly includeSecrets: boolean;
  readonly schedule: {
    readonly localIntervalMinutes: number;
    readonly r2IntervalHours: number;
    readonly fullIntervalDays: number;
  };
  readonly retention: {
    readonly maxBackups: number;
    readonly retentionDays: number | null;
  };
  readonly lastFingerprint: string | null;
  readonly estimatedBytes: number;
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
  readonly includesSecrets: boolean;
  readonly files: readonly BackupFilePreview[];
  readonly warnings: readonly string[];
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  readonly id: string;
  readonly kind: 'installation';
  readonly state: JobState;
  readonly progress: number;
  readonly step: string;
  readonly installationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

export interface LogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly source: 'manager' | 'sillytavern' | 'cloudflared' | 'installer' | 'backup';
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
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
}

export type TunnelMode = 'off' | 'quick' | 'named';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface TunnelState {
  readonly mode: TunnelMode;
  readonly status: TunnelStatus;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly error: string | null;
}
