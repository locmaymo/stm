import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KEEP_ONLINE_DEFAULT_MINUTES, SETUP_STEPS, type ManagerState, type SetupStep } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { LEGAL_META } from '../../../packages/legal/src/index.js';
import { SILLYTAVERN_PORT } from './ports.js';
import { intervalMinutes } from './online.js';
import { MANAGER_VERSION } from './version.js';

const STATE_FILE_NAME = 'manager-state.json';
const STATE_SCHEMA_VERSION = 1 as const;
/*
 * What an operator agreed to, named by the revision of the text they were
 * shown rather than by a date written here by hand. The legal package is the
 * one copy of that text, so when it is revised this record follows it and a
 * state file says which wording was actually on screen.
 */
const TERMS_VERSION = LEGAL_META.effective;
const TELEMETRY_NOTICE_VERSION = LEGAL_META.effective;

interface PersistedManagerState {
  readonly schemaVersion: 1;
  readonly managerVersion: string;
  readonly installId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly adminPasswordHash: string | null;
  /** The password the access gateway asks for, separate from the one above. */
  readonly accessPasswordHash: string | null;
  /** Whether that hash came from a six-digit passcode; see AccessGatewayState. */
  readonly accessPasscode: boolean;
  /** Whether that gateway binds to the local network or to this machine only. */
  readonly accessLanEnabled: boolean;
  /**
   * Which port SillyTavern is started on.
   *
   * Kept here rather than read back from config.yaml because the console is
   * what has to guarantee it does not collide with its own port or the
   * gateway's, and a config restored from another machine carries that
   * machine's answer.
   */
  readonly sillyTavernPort: number;
  readonly setupAcceptedAt: string | null;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  /**
   * When the reader last acknowledged a revision of the terms after setup.
   *
   * Separate from `setupAcceptedAt`, which is the moment this installation was
   * created and never moves again. This moves every time the documents are
   * revised and somebody says they have read the new ones, so between them the
   * file records both when the manager was set up and under which wording it
   * has been running since. Null on an installation that has never been asked,
   * which is every one set up under the revision still in force.
   */
  readonly noticeAcknowledgedAt: string | null;
  /**
   * Whether SillyTavern is started when the manager is.
   *
   * On, because the manager exists to run SillyTavern and a console that has
   * to be told to start it every time is one step in front of the thing
   * everybody actually opened it for. Off is for somebody who runs SillyTavern
   * themselves, or who opens the console to look at backups on a machine they
   * do not want a second process on.
   */
  readonly autoStartSillyTavern: boolean;
  /**
   * When the manager installed SillyTavern by itself, if it ever did.
   *
   * A fresh manager with a password just set has nothing installed and one
   * obvious next step, and making the reader find and press it is asking them
   * to confirm the only thing the program does. It is done once and recorded,
   * so somebody who later removes SillyTavern on purpose does not find it
   * installing itself again on the next start.
   */
  readonly firstInstallStartedAt: string | null;
  /**
   * Whether the manager keeps itself online; see `online.ts`.
   *
   * On, because the cost of it being on where it is not needed is nothing -
   * a manager with no outside address never makes a request - and the cost of
   * it being off where it is needed is SillyTavern disappearing mid-sentence
   * on a machine the reader cannot do anything about. Off is for somebody who
   * would rather the machine be allowed to go quiet.
   */
  readonly keepOnline: boolean;
  /** How many minutes between attempts when it is on; see `online.ts`. */
  readonly keepOnlineMinutes: number;
  /**
   * The address a browser last reached this console at, when one has.
   *
   * Remembered across restarts because a restart is exactly when it matters: a
   * manager that has just been brought back up while nobody is looking has no
   * idea where it is, and the thing it is trying to prevent is being put to
   * sleep again before anybody opens it. Null until a console teaches it one,
   * and null again if that address stops answering for long enough.
   *
   * Not in the record the bucket keeps. It says where this machine is, not how
   * it was set up, and a machine restored somewhere else would inherit an
   * address belonging to the machine it replaced.
   */
  readonly keepOnlineOrigin: string | null;
  /**
   * The Cloudflare account allowed to sign in to this manager, if one has
   * claimed it.
   *
   * A manager can be opened with a password, with a Cloudflare account, or
   * with either - and the second is what makes a machine that loses its disk
   * every few days usable at all: there is nothing to set up again, because
   * the sign-in is the setup. The first account to sign in claims the manager,
   * exactly as the first person to reach a manager with no password is the one
   * who sets it; afterwards only that account is let in.
   *
   * The account's identifier, never a token. The tokens live in the Cloudflare
   * connection's own file, and this says nothing about whether one is valid -
   * only about whose manager this is.
   */
  readonly ownerAccountId: string | null;
  /** What to call that account on screen, so a refusal can name it. */
  readonly ownerAccountName: string | null;
  /**
   * Saver mode as the panel's switch last set it, or null for never.
   *
   * Null is not off: it leaves the answer to how much memory the machine has.
   */
  readonly saverMode: boolean | null;
  /** Whether SillyTavern's access link has ever been turned on; see `AccessGatewayState.opened`. */
  readonly accessLinkOpened: boolean;
  /**
   * Whether the first run was put off until the next sign-in.
   *
   * Set up inside a studio's frame and asked for a link of its own, the reader
   * is about to leave for that link. Installing SillyTavern while they go
   * would be work started in a place they have already left, so it waits for
   * them to sign in at the link.
   */
  readonly firstRunDeferred: boolean;
  /** The checklist steps seen done, which stay done; see `SetupChecklistState`. */
  readonly setupStepsDone: readonly SetupStep[];
}

export interface StateStoreOptions {
  readonly paths?: PlatformPaths;
  readonly managerVersion?: string;
  readonly now?: () => Date;
}

export class StateStore {
  readonly paths: PlatformPaths;
  private readonly managerVersion: string;
  private readonly now: () => Date;
  private state: PersistedManagerState | null = null;
  private adminWriteQueue: Promise<void> = Promise.resolve();

  public constructor(options: StateStoreOptions = {}) {
    this.paths = options.paths ?? getPlatformPaths();
    this.managerVersion = options.managerVersion ?? MANAGER_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  public async load(): Promise<PersistedManagerState> {
    if (this.state) {
      return this.state;
    }
    await this.ensureDirectories();
    try {
      const raw = await readFile(this.stateFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const stored = this.parsePersistedState(parsed);
      /*
       * The version is recorded when the file is created, and an installation
       * outlives many versions of the manager that reads it. Left alone, a
       * state file written on a first install reported that version for the
       * rest of its life - in the banner, in the health response, and on every
       * usage summary. It is refreshed here, once, on the start that finds it
       * stale.
       */
      this.state = stored.managerVersion === this.managerVersion
        ? stored
        : { ...stored, managerVersion: this.managerVersion, updatedAt: this.now().toISOString() };
      if (this.state !== stored) await this.write(this.state);
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
        accessPasswordHash: null,
        accessPasscode: false,
        accessLanEnabled: false,
        sillyTavernPort: SILLYTAVERN_PORT,
        setupAcceptedAt: null,
        termsVersion: TERMS_VERSION,
        telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION,
        noticeAcknowledgedAt: null,
        autoStartSillyTavern: true,
        firstInstallStartedAt: null,
        keepOnline: true,
        keepOnlineMinutes: KEEP_ONLINE_DEFAULT_MINUTES,
        keepOnlineOrigin: null,
        ownerAccountId: null,
        ownerAccountName: null,
        saverMode: null,
        accessLinkOpened: false,
        firstRunDeferred: false,
        setupStepsDone: [],
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

  /**
   * Save the password that opens SillyTavern, replacing any earlier one.
   *
   * Unlike the manager password this has no "only once" rule: it guards a door
   * that is meant to be handed out and taken back.
   */
  public async setAccessPassword(passwordHash: string, passcode: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      const updated: PersistedManagerState = { ...state, accessPasswordHash: passwordHash, accessPasscode: passcode, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /** Record the port SillyTavern is to be started on from now on. */
  public async setSillyTavernPort(port: number): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.sillyTavernPort === port) return;
      const updated: PersistedManagerState = { ...state, sillyTavernPort: port, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /**
   * Record that the reader has acknowledged the revision now in force.
   *
   * The revision is passed in rather than read from the legal package here,
   * because the caller is the one that checked which revision the reader was
   * actually shown - a console left open across an update could otherwise
   * acknowledge wording that arrived after the card it answered.
   *
   * Both versions move together. They are one document set, shown on one
   * screen, agreed to in one gesture, and keeping two dates that can differ
   * would be recording a distinction nobody was ever offered.
   */
  public async acknowledgeNotice(revision: string): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      const now = this.now().toISOString();
      const updated: PersistedManagerState = {
        ...state,
        termsVersion: revision,
        telemetryNoticeVersion: revision,
        noticeAcknowledgedAt: now,
        // A manager claimed by a Cloudflare account on a machine that lost its
        // disk can reach this with nothing on record; the acknowledgement is
        // an acceptance in that case, and there is no earlier one to keep.
        setupAcceptedAt: state.setupAcceptedAt ?? now,
        updatedAt: now,
      };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /** Whether the manager keeps itself online, and how often; see `online.ts`. */
  public async setKeepOnline(enabled: boolean, minutes: number): Promise<void> {
    const wanted = intervalMinutes(minutes);
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.keepOnline === enabled && state.keepOnlineMinutes === wanted) return;
      const updated: PersistedManagerState = { ...state, keepOnline: enabled, keepOnlineMinutes: wanted, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /**
   * Write down the address a browser reached this console at.
   *
   * Written rarely - it changes when the machine moves or is redeployed, not
   * on every request - and through the same queue as every other change, so it
   * cannot land between another write's read and its save.
   */
  public async setKeepOnlineOrigin(origin: string | null): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.keepOnlineOrigin === origin) return;
      const updated: PersistedManagerState = { ...state, keepOnlineOrigin: origin, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /**
   * Put the first run off until the next sign-in, or take it back.
   *
   * Returns whether it was waiting, so the sign-in that takes it is the only one.
   */
  public async setFirstRunDeferred(deferred: boolean): Promise<boolean> {
    let was = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      was = state.firstRunDeferred;
      if (was === deferred) return;
      const updated: PersistedManagerState = { ...state, firstRunDeferred: deferred, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return was;
  }

  /** The panel's saver mode switch; see `saver.ts`. */
  public async setSaverMode(enabled: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.saverMode === enabled) return;
      const updated: PersistedManagerState = { ...state, saverMode: enabled, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /** The access link has been turned on; that stays done. */
  public async setAccessLinkOpened(): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.accessLinkOpened) return;
      const updated: PersistedManagerState = { ...state, accessLinkOpened: true, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /** Write down checklist steps as done; returns every step done so far. */
  public async markSetupStepsDone(steps: readonly SetupStep[]): Promise<readonly SetupStep[]> {
    let done: readonly SetupStep[] = [];
    const operation = async (): Promise<void> => {
      const state = await this.load();
      done = state.setupStepsDone;
      if (steps.every((step) => done.includes(step))) return;
      done = SETUP_STEPS.filter((step) => done.includes(step) || steps.includes(step));
      const updated: PersistedManagerState = { ...state, setupStepsDone: done, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return done;
  }

  /** Whether SillyTavern comes up with the manager. */
  public async setAutoStartSillyTavern(enabled: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.autoStartSillyTavern === enabled) return;
      const updated: PersistedManagerState = { ...state, autoStartSillyTavern: enabled, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /**
   * Claim the one automatic first install, or find that it is already claimed.
   *
   * True exactly once per installation of the manager. Written through the
   * same queue as everything else here, so two requests arriving together
   * cannot both be told to go ahead.
   */
  public async claimFirstInstall(): Promise<boolean> {
    let claimed = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.firstInstallStartedAt !== null) return;
      const now = this.now().toISOString();
      const updated: PersistedManagerState = { ...state, firstInstallStartedAt: now, updatedAt: now };
      await this.write(updated);
      this.state = updated;
      claimed = true;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return claimed;
  }

  public async setAccessLan(enabled: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.accessLanEnabled === enabled) return;
      const updated: PersistedManagerState = { ...state, accessLanEnabled: enabled, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  public async bootstrapAdminPassword(passwordHash: string): Promise<boolean> {
    const state = await this.load();
    if (state.adminPasswordHash) {
      return false;
    }
    return this.saveAdminPassword(passwordHash);
  }

  /**
   * Set the console's password, whether or not there was one before.
   *
   * `saveAdminPassword` refuses when one exists and `changeAdminPassword`
   * refuses when one does not, which between them cover setup and the settings
   * page - but not the console that was opened with a Cloudflare account and
   * has never had a password at all. Somebody there asking for one was told to
   * "finish setting the manager up first", on a manager they were already
   * signed in to. This is for callers that have already established who is
   * asking and only need the hash written.
   */
  public async setAdminPassword(passwordHash: string): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      const now = this.now().toISOString();
      const updated: PersistedManagerState = {
        ...state,
        adminPasswordHash: passwordHash,
        // A manager claimed by a Cloudflare account accepted the terms on the
        // screen that offered the sign-in, so this is usually already set.
        setupAcceptedAt: state.setupAcceptedAt ?? now,
        updatedAt: now,
      };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  public async changeAdminPassword(passwordHash: string): Promise<boolean> {
    let changed = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (!state.adminPasswordHash) {
        return;
      }
      const updated: PersistedManagerState = {
        ...state,
        adminPasswordHash: passwordHash,
        updatedAt: this.now().toISOString(),
      };
      await this.write(updated);
      this.state = updated;
      changed = true;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return changed;
  }

  /**
   * Let a Cloudflare account open this manager, or find out it already may.
   *
   * The first account to ask claims it, and the answer says whether it was
   * this one. An account that is not the owner is refused rather than added:
   * a manager with an owner is not a door that the next person to arrive gets
   * a key to.
   *
   * Through the same queue as every other write, so two sign-ins landing
   * together cannot both be told they are the owner.
   */
  public async claimCloudflareOwner(accountId: string, accountName: string): Promise<{ readonly allowed: boolean; readonly owner: string | null }> {
    let allowed = false;
    let owner: string | null = null;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      owner = state.ownerAccountName ?? state.ownerAccountId;
      if (state.ownerAccountId !== null) { allowed = state.ownerAccountId === accountId; return; }
      const now = this.now().toISOString();
      const updated: PersistedManagerState = {
        ...state,
        ownerAccountId: accountId,
        ownerAccountName: accountName,
        // Claiming a manager with a Cloudflare account is setting it up, so
        // the terms were accepted on the screen that offered the sign-in.
        setupAcceptedAt: state.setupAcceptedAt ?? now,
        updatedAt: now,
      };
      await this.write(updated);
      this.state = updated;
      allowed = true;
      owner = accountName;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return { allowed, owner };
  }

  /** Stop letting a Cloudflare account open this manager. */
  public async releaseCloudflareOwner(): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.ownerAccountId === null) return;
      const updated: PersistedManagerState = { ...state, ownerAccountId: null, ownerAccountName: null, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  public async getPersisted(): Promise<PersistedManagerState> {
    return this.load();
  }

  /**
   * Wait for every write already queued to reach the disk.
   *
   * The same idea as the backup and profile stores' own `settle`. Most writes
   * here are awaited by whoever asked for them, but not all: the address a
   * console teaches the manager is written without anything waiting on it,
   * because nothing needs it until the next start.
   */
  public async settle(): Promise<void> {
    const previous = this.adminWriteQueue;
    const done = previous.then(() => undefined, () => undefined);
    this.adminWriteQueue = done;
    await done;
  }

  /**
   * Forget the state held in memory, so the next read is of the disk again.
   *
   * For the one caller that deletes the file underneath this store: a reset.
   * Without it the manager would keep answering from the state it happened to
   * be holding - the password that has just been erased included - and write it
   * back on the next change, so the wipe would undo itself.
   *
   * Through the same queue as every write, so it cannot land between a write's
   * read and its save and leave the file holding what was just forgotten.
   */
  public async forget(): Promise<void> {
    const operation = async (): Promise<void> => { this.state = null; };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
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
    if (!isNullableString(input.adminPasswordHash)) {
      throw new Error('Invalid manager state secret field');
    }
    if (!isNullableString(input.setupAcceptedAt)) {
      throw new Error('Invalid manager state timestamp field');
    }
    // State written before the access gateway existed has neither key, and a
    // missing one means the same as its default rather than a broken file.
    const accessPasswordHash = isNullableString(input.accessPasswordHash) ? input.accessPasswordHash : null;
    const accessLanEnabled = input.accessLanEnabled === true;
    // Absent in a file written before passcodes existed, which is exactly the
    // case that has to keep its password field.
    const accessPasscode = input.accessPasscode === true;
    // Written before the port could be moved, or written by a newer version and
    // read back by an older one: either way the shipped port is the answer that
    // matches what the file it describes actually says.
    const storedPort = input.sillyTavernPort;
    const sillyTavernPort = typeof storedPort === 'number' && Number.isInteger(storedPort) && storedPort > 0 && storedPort <= 65535
      ? storedPort
      : SILLYTAVERN_PORT;
    // Absent in a file written before these existed. The first is on by
    // default, so only an explicit `false` turns it off; the second says the
    // automatic install has not happened, which for an existing installation
    // is settled a moment later by there already being one.
    const autoStartSillyTavern = input.autoStartSillyTavern !== false;
    const firstInstallStartedAt = isNullableString(input.firstInstallStartedAt) ? input.firstInstallStartedAt : null;
    // Absent in a file written before the manager kept itself online, which is
    // on by default, so only an explicit `false` turns it off. The interval is
    // held inside what the keeper will actually do, so a file carrying a
    // nonsense number is corrected rather than obeyed or refused.
    const keepOnline = input.keepOnline !== false;
    const keepOnlineMinutes = intervalMinutes(input.keepOnlineMinutes);
    const keepOnlineOrigin = isNullableString(input.keepOnlineOrigin) ? input.keepOnlineOrigin : null;
    // Absent in a file written before a Cloudflare account could open this
    // manager, which is a manager nobody has claimed that way.
    const ownerAccountId = isNullableString(input.ownerAccountId) ? input.ownerAccountId : null;
    const ownerAccountName = isNullableString(input.ownerAccountName) ? input.ownerAccountName : null;
    // Absent in every file written before the terms could be revised under a
    // running installation, which is one that has never been asked.
    const noticeAcknowledgedAt = isNullableString(input.noticeAcknowledgedAt) ? input.noticeAcknowledgedAt : null;
    // Absent in a file written before saver mode existed: nobody has chosen.
    const saverMode = typeof input.saverMode === 'boolean' ? input.saverMode : null;
    const firstRunDeferred = input.firstRunDeferred === true;
    // Absent in a file written before the checklist asked: not yet, as far as
    // anybody can tell.
    const accessLinkOpened = input.accessLinkOpened === true;
    // Absent in a file written before steps were remembered: none yet, and
    // the panel writes down again whatever it finds already done.
    const recorded: readonly unknown[] = Array.isArray(input.setupStepsDone) ? input.setupStepsDone : [];
    const setupStepsDone = SETUP_STEPS.filter((step) => recorded.includes(step));
    return { ...input, accessPasswordHash, accessPasscode, accessLanEnabled, sillyTavernPort, autoStartSillyTavern, firstInstallStartedAt, keepOnline, keepOnlineMinutes, keepOnlineOrigin, ownerAccountId, ownerAccountName, noticeAcknowledgedAt, saverMode, accessLinkOpened, firstRunDeferred, setupStepsDone } as unknown as PersistedManagerState;
  }
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
