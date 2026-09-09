import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagerState } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, type PlatformPaths } from '../../../packages/platform/src/index.js';

const STATE_FILE_NAME = 'manager-state.json';
const STATE_SCHEMA_VERSION = 1 as const;
const TERMS_VERSION = '2026-09-09';
const TELEMETRY_NOTICE_VERSION = '2026-09-09';

interface PersistedManagerState {
  readonly schemaVersion: 1;
  readonly managerVersion: string;
  readonly installId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly adminPasswordHash: string | null;
  readonly setupAcceptedAt: string | null;
  readonly setupCode: string | null;
  readonly setupCodeHash: string | null;
  readonly setupCodeCreatedAt: string | null;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
}

export interface StateStoreOptions {
  readonly paths?: PlatformPaths;
  readonly managerVersion?: string;
  readonly now?: () => Date;
  readonly setupCode?: string;
}

export class StateStore {
  readonly paths: PlatformPaths;
  private readonly managerVersion: string;
  private readonly now: () => Date;
  private state: PersistedManagerState | null = null;
  private initialSetupCode: string;
  private adminWriteQueue: Promise<void> = Promise.resolve();

  public constructor(options: StateStoreOptions = {}) {
    this.paths = options.paths ?? getPlatformPaths();
    this.managerVersion = options.managerVersion ?? '0.1.0';
    this.now = options.now ?? (() => new Date());
    this.initialSetupCode = options.setupCode ?? randomBytes(18).toString('base64url');
  }

  public async load(): Promise<PersistedManagerState> {
    if (this.state) {
      return this.state;
    }
    await this.ensureDirectories();
    try {
      const raw = await readFile(this.stateFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const parsedState = this.parsePersistedState(parsed);
      if (!parsedState.adminPasswordHash && !parsedState.setupCode) {
        const refreshed: PersistedManagerState = {
          ...parsedState,
          setupCode: this.initialSetupCode,
          setupCodeHash: sha256(this.initialSetupCode),
          updatedAt: this.now().toISOString(),
        };
        await this.write(refreshed);
        this.state = refreshed;
        return refreshed;
      }
      if (parsedState.setupCode) {
        this.initialSetupCode = parsedState.setupCode;
      }
      this.state = parsedState;
      return this.state;
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }
      const now = this.now().toISOString();
      const state: PersistedManagerState = {
        schemaVersion: STATE_SCHEMA_VERSION,
        managerVersion: this.managerVersion,
        installId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        adminPasswordHash: null,
        setupAcceptedAt: null,
        setupCode: this.initialSetupCode,
        setupCodeHash: sha256(this.initialSetupCode),
        setupCodeCreatedAt: now,
        termsVersion: TERMS_VERSION,
        telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION,
      };
      await this.write(state);
      this.state = state;
      return state;
    }
  }

  public async saveAdminPassword(passwordHash: string, acceptedAt = this.now().toISOString()): Promise<boolean> {
    let saved = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.adminPasswordHash) {
        return;
      }
      const updated: PersistedManagerState = {
        ...state,
        adminPasswordHash: passwordHash,
        setupAcceptedAt: acceptedAt,
        setupCode: null,
        setupCodeHash: null,
        setupCodeCreatedAt: null,
        updatedAt: acceptedAt,
      };
      await this.write(updated);
      this.state = updated;
      saved = true;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return saved;
  }

  public async bootstrapAdminPassword(passwordHash: string): Promise<boolean> {
    const state = await this.load();
    if (state.adminPasswordHash) {
      return false;
    }
    return this.saveAdminPassword(passwordHash);
  }

  public async clearSetupCode(): Promise<void> {
    const state = await this.load();
    const updated: PersistedManagerState = {
      ...state,
      setupCode: null,
      setupCodeHash: null,
      setupCodeCreatedAt: null,
      updatedAt: this.now().toISOString(),
    };
    await this.write(updated);
    this.state = updated;
  }

  public async getPersisted(): Promise<PersistedManagerState> {
    return this.load();
  }

  public toPublicState(): ManagerState {
    const state = this.state;
    if (!state) {
      throw new Error('State must be loaded before it can be read');
    }
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      managerVersion: state.managerVersion,
      installId: state.installId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      adminConfigured: state.adminPasswordHash !== null,
      setupAcceptedAt: state.setupAcceptedAt,
      termsVersion: state.termsVersion,
      telemetryNoticeVersion: state.telemetryNoticeVersion,
      platform: this.paths.platform,
      storageRoot: this.paths.root,
      storageDurable: this.paths.platform !== 'unknown',
    };
  }

  public getSetupCodeForTests(): string {
    return this.state?.setupCode ?? this.initialSetupCode;
  }

  private stateFile(): string {
    return join(this.paths.state, STATE_FILE_NAME);
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.state, { recursive: true }),
      mkdir(this.paths.profiles, { recursive: true }),
      mkdir(this.paths.archives, { recursive: true }),
      mkdir(this.paths.logs, { recursive: true }),
      mkdir(this.paths.metrics, { recursive: true }),
      mkdir(this.paths.outbox, { recursive: true }),
      mkdir(this.paths.tmp, { recursive: true }),
      mkdir(this.paths.bin, { recursive: true }),
    ]);
  }

  private async write(state: PersistedManagerState): Promise<void> {
    await this.ensureDirectories();
    const target = this.stateFile();
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private parsePersistedState(input: unknown): PersistedManagerState {
    if (!isRecord(input) || input.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new Error('Unsupported manager state schema');
    }
    const requiredStrings = [
      'managerVersion',
      'installId',
      'createdAt',
      'updatedAt',
      'termsVersion',
      'telemetryNoticeVersion',
    ] as const;
    for (const key of requiredStrings) {
      if (typeof input[key] !== 'string' || input[key].length === 0) {
        throw new Error(`Invalid manager state field: ${key}`);
      }
    }
    if (!isNullableString(input.adminPasswordHash) || !isNullableString(input.setupCodeHash)) {
      throw new Error('Invalid manager state secret field');
    }
    if (!isNullableString(input.setupAcceptedAt) || !isNullableString(input.setupCodeCreatedAt)) {
      throw new Error('Invalid manager state timestamp field');
    }
    const setupCode = isNullableString(input.setupCode) ? input.setupCode : null;
    return { ...input, setupCode } as unknown as PersistedManagerState;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export function hashSetupCode(code: string): string {
  return sha256(code);
}
