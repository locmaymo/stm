import type { ManagerSettingsOffer, ManagerSettingsRecord } from '../../../packages/contracts/src/index.js';
import { logEvent, logLineText, type LogSink } from '../../../packages/contracts/src/index.js';
import type { BackupStore } from '../../../packages/backup/src/index.js';
import type { R2Manager } from '../../../packages/r2/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import type { TunnelManager } from '../../../packages/tunnel/src/index.js';
import type { AccessGateway } from './gateway.js';
import type { StateStore } from './state.js';
import { checkSillyTavernPort, PortError } from './ports.js';

/**
 * The manager's own settings, into the bucket and back out of it.
 *
 * The data was always the part worth keeping somewhere else, and a machine
 * that came back with it still arrived blank: a console with no password, a
 * SillyTavern nobody could reach from a phone, a backup schedule set to the
 * defaults, and whatever release happened to be current rather than the one
 * that was being run. This is the rest of the answer to "my machine is gone".
 *
 * Reading is offered, never applied on its own. The record carries the hash of
 * the console's password, and a console that changed its own password because
 * a bucket told it to - with nobody watching, on a machine the reader may not
 * even have set up yet - is not a thing this should do quietly.
 */
export interface ManagerSettingsDeps {
  readonly store: StateStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly runtime: RuntimeManager;
  /** The two doors onto the internet, which are part of how a machine was set up. */
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  /** The door the tunnels publish, which has to know the credential first. */
  readonly gateway: AccessGateway;
  /**
   * Put the running manager on the SillyTavern port that came back.
   *
   * Writing the state file is not enough, and this is the part that was
   * missing. A running manager does not read the port from the file: the
   * gateway it forwards through, the health check that waits for SillyTavern
   * to answer and the writer of config.yaml each took the port when the
   * manager started and hold it. So a machine restored from its own settings
   * showed 8006 on its settings page, wrote 8006 into the state file, and
   * started SillyTavern on the default - which is the one part of a restore
   * the reader notices the minute they open it.
   *
   * Optional, because reading and writing the record needs none of this.
   */
  readonly adoptSillyTavernPort?: (port: number) => Promise<void>;
  readonly logger?: LogSink;
}

/** What this machine is set to right now, in the shape the bucket keeps. */
export async function currentManagerSettings(deps: ManagerSettingsDeps): Promise<Omit<ManagerSettingsRecord, 'label' | 'writtenAt'>> {
  const state = await deps.store.getPersisted();
  const schedule = await deps.backups.getSchedule();
  const r2 = await deps.r2.getConfig();
  const installation = await deps.runtime.getActiveInstallation();
  return {
    schemaVersion: 1,
    installId: state.installId,
    adminPasswordHash: state.adminPasswordHash,
    accessPasswordHash: state.accessPasswordHash,
    accessPasscode: state.accessPasscode,
    accessLanEnabled: state.accessLanEnabled,
    tunnelQuick: deps.tunnel.getState().mode === 'quick',
    managerTunnelQuick: deps.managerTunnel.getState().mode === 'quick',
    autoStartSillyTavern: state.autoStartSillyTavern,
    sillyTavernPort: state.sillyTavernPort,
    localIntervalMinutes: schedule.intervalMinutes,
    r2: {
      hotIntervalMinutes: r2.schedule.hotIntervalMinutes,
      coldIntervalHours: r2.schedule.coldIntervalHours,
      reconcileIntervalHours: r2.schedule.reconcileIntervalHours,
      keepRecent: r2.retention.keepRecent,
      keepDaily: r2.retention.keepDaily,
      keepWeekly: r2.retention.keepWeekly,
      maxStorageBytes: r2.limits.maxStorageBytes,
      maxWriteOperations: r2.limits.maxWriteOperations,
      maxReadOperations: r2.limits.maxReadOperations,
    },
    versionSelector: installation?.selector ?? null,
    versionRef: installation?.resolvedRef ?? null,
  };
}

/**
 * Put them in the bucket if they have moved since the last time.
 *
 * `force` is for a person who pressed a button: it goes and reads the record
 * in the bucket instead of trusting what this process remembers sending. See
 * `R2Manager.saveManagerSettings`.
 */
export async function saveManagerSettings(deps: ManagerSettingsDeps, options: { readonly force?: boolean } = {}): Promise<boolean> {
  return await deps.r2.saveManagerSettings(await currentManagerSettings(deps), options);
}

/**
 * The setup of some other machine, as this bucket still holds it.
 *
 * Two places to look, because one bucket describes one machine and this one
 * writes its own settings over whatever was there. That is right - it is the
 * machine now - and it was quietly destroying the thing the console was in the
 * middle of offering: a minute after signing in, the card still named the old
 * machine while the record behind it had already become this one's, so
 * pressing Restore everything restored this machine onto itself.
 *
 * So the record being replaced is kept beside the current one, and that is
 * what this falls back to. Null when neither is another machine's, which is
 * the ordinary state of a machine that has been running for a while.
 */
export async function foreignManagerSettings(deps: ManagerSettingsDeps): Promise<ManagerSettingsRecord | null> {
  const current = await deps.r2.loadManagerSettings().catch(() => null);
  if (current && !await isMine(deps, current)) return current;
  const previous = await deps.r2.loadPreviousManagerSettings().catch(() => null);
  if (previous && !await isMine(deps, previous)) return previous;
  return null;
}

/** What the panel is told about settings some machine has left in the bucket. */
export async function managerSettingsOffer(deps: ManagerSettingsDeps): Promise<ManagerSettingsOffer> {
  const record = await foreignManagerSettings(deps);
  if (!record) return { available: false, label: null, writtenAt: null, mine: false, hasAdminPassword: false, hasAccessPassword: false };
  return {
    available: true,
    label: record.label,
    writtenAt: record.writtenAt,
    // Never this machine's, by construction: that is the whole of what the
    // lookup above decides. Kept in the shape the panel already reads.
    mine: false,
    hasAdminPassword: record.adminPasswordHash !== null,
    hasAccessPassword: record.accessPasswordHash !== null,
  };
}

export interface ApplyManagerSettingsResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Put a record back on this machine.
 *
 * Every part is optional, because the parts are not equally welcome: somebody
 * moving to a new computer wants the console password back, and somebody who
 * has already set this machine up and only wants their schedule does not.
 *
 * What was applied and what was not is reported rather than assumed. The port
 * is the one that can be refused on its own - another program may hold it
 * here, which says nothing about the machine the record came from - and being
 * told so is better than a console that quietly runs on a different port than
 * the one it says it restored.
 */
export async function applyManagerSettings(deps: ManagerSettingsDeps, record: ManagerSettingsRecord, wanted: {
  readonly passwords: boolean;
  readonly schedules: boolean;
  readonly ports: { readonly manager: number; readonly access: number };
}): Promise<ApplyManagerSettingsResult> {
  const logger: LogSink = deps.logger ?? ((line) => console.log(logLineText(line)));
  const applied: string[] = [];
  const skipped: string[] = [];

  if (wanted.passwords) {
    if (record.adminPasswordHash) {
      // The console's own door, set whether or not this machine already has
      // one: a machine restoring settings may be in either state.
      await deps.store.setAdminPassword(record.adminPasswordHash);
      applied.push('managerPassword');
    } else skipped.push('managerPassword');
    if (record.accessPasswordHash) {
      await deps.store.setAccessPassword(record.accessPasswordHash, record.accessPasscode);
      applied.push('accessPassword');
    } else skipped.push('accessPassword');
    await deps.store.setAccessLan(record.accessLanEnabled);
    applied.push('accessNetwork');
    /*
     * The gateway is still holding the credential and the binding this machine
     * had a moment ago, neither of which is what it has just been told to use.
     *
     * Told here rather than after this returns, because a tunnel refuses to
     * open in front of a door with no password on it - so a restore that set
     * the passcode in the state file and told the gateway afterwards started
     * the tunnel in between and had it refused, on a machine whose passcode
     * had just come back.
     */
    const access = await deps.store.getPersisted();
    deps.gateway.setPassword(access.accessPasswordHash, access.accessPasscode);
    await deps.gateway.setLan(access.accessLanEnabled).catch(() => undefined);
    /*
     * The tunnels, which are the other half of how this machine was reached.
     *
     * Restoring the passcode and leaving the tunnel off gives somebody the key
     * to a door that is not there - and it is the one part of a restore that
     * is visible from the phone they were using, so its absence read as the
     * whole restore having failed. Starting one takes seconds and can fail on
     * its own; it is not allowed to take the rest of the restore with it.
     */
    if (await restoreQuickTunnel(deps.tunnel, record.tunnelQuick)) applied.push('accessTunnel');
    if (await restoreQuickTunnel(deps.managerTunnel, record.managerTunnelQuick)) applied.push('managerTunnel');
  }

  if (wanted.schedules) {
    await deps.backups.setSchedule({ intervalMinutes: record.localIntervalMinutes });
    await deps.r2.update({ ...record.r2 });
    await deps.store.setAutoStartSillyTavern(record.autoStartSillyTavern);
    applied.push('schedules');
  }

  try {
    const port = checkSillyTavernPort(record.sillyTavernPort, wanted.ports);
    await deps.store.setSillyTavernPort(port);
    // The file and the running manager, not the file alone. See the note on
    // `adoptSillyTavernPort`.
    await deps.adoptSillyTavernPort?.(port);
    applied.push('sillyTavernPort');
  } catch (error: unknown) {
    // Held by something else here, or out of range. The manager keeps the port
    // it already had, which is one that works on this machine.
    if (!(error instanceof PortError)) throw error;
    skipped.push('sillyTavernPort');
  }

  logger(logEvent('r2.settingsRestored', `[r2] restored the manager’s settings from ${record.label}: ${applied.join(', ') || 'nothing'}`, { from: record.label, applied: applied.join(', ') }));
  /*
   * The record in the bucket now describes this machine, so it should say so.
   *
   * Without this the console went on offering the restore it had just carried
   * out, for as long as the record kept the previous installation's id - which
   * reads as the restore not having worked. Best effort: the bucket may not be
   * this machine's to write to yet, and the scheduler writes these anyway. A
   * restore that happened is not undone by a write that did not.
   */
  await saveManagerSettings(deps).catch(() => false);
  /*
   * The kept copy of the record just restored, thrown away.
   *
   * It exists only to survive the window between a handover and this moment;
   * left behind, it would be offered again for the life of the bucket, to the
   * machine that has this second finished restoring it.
   */
  await deps.r2.forgetPreviousManagerSettings().catch(() => undefined);
  return { applied, skipped };
}

/**
 * Everything this machine is missing, without asking for any of it.
 *
 * For the one case where there is nobody to ask and nothing to lose: somebody
 * has just opened a manager with a Cloudflare account, and the manager has no
 * settings of its own to overwrite. A host that starts from the checkout every
 * time is the reason this exists - one sign-in, and the machine is the machine
 * it was, rather than a fresh install with the reader's chats in it.
 *
 * Deliberately narrow. Settings are applied only where this manager has none
 * of its own, so a console somebody has already set up is never rearranged by
 * signing in to it; the passwords go back only where none is set, so a sign-in
 * cannot quietly replace the password somebody is using.
 */
export async function restoreFromBucketIfBlank(deps: ManagerSettingsDeps, options: { readonly ports: { readonly manager: number; readonly access: number } }): Promise<{ readonly applied: readonly string[]; readonly record: ManagerSettingsRecord } | null> {
  const logger: LogSink = deps.logger ?? ((line) => console.log(logLineText(line)));
  const state = await deps.store.getPersisted();
  const record = await foreignManagerSettings(deps);
  if (!record) return null;
  // Somebody set this machine up by hand and is now adding a Cloudflare
  // account to it. Their password stays theirs.
  const blank = state.adminPasswordHash === null;
  if (!blank) {
    logger(logEvent('r2.settingsOffered', '[r2] this account holds settings from another machine; they are on the Data page rather than applied, because this one is already set up', {}));
    return null;
  }
  const result = await applyManagerSettings(deps, record, { passwords: true, schedules: true, ports: options.ports });
  // The record comes back with the outcome because it says more than was
  // applied here: which release this machine was running is not a setting to
  // write down, it is a thing to go and install.
  return { applied: result.applied, record };
}

/**
 * Put a Quick Tunnel back the way the record found it, and say whether it moved.
 *
 * Only the quick kind is restored, because only the quick kind can be: a Named
 * Tunnel needs its token, which is not in the record. A machine that was
 * running one is therefore left alone rather than having it turned off.
 */
async function restoreQuickTunnel(tunnel: TunnelManager, wanted: boolean): Promise<boolean> {
  const mode = tunnel.getState().mode;
  if (mode === 'named') return false;
  if (wanted === (mode === 'quick')) return false;
  try {
    if (wanted) await tunnel.start('quick');
    else await tunnel.disable();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the record in the bucket is the one this installation wrote.
 *
 * By installation id, which is made once per data directory and written into
 * the record. It used to be the console's password hash, which is wrong twice
 * over: a manager opened with a Cloudflare account has no password at all, so
 * every such machine was offered its own settings back minutes after writing
 * them - "another machine has settings here", about itself - and two machines
 * that happened to share a password would each have claimed the other's.
 *
 * The hash is still the answer for a record written before the id existed,
 * where it is the only thing there is to go on.
 */
async function isMine(deps: ManagerSettingsDeps, record: ManagerSettingsRecord): Promise<boolean> {
  const state = await deps.store.getPersisted();
  if (record.installId !== null) return record.installId === state.installId;
  return state.adminPasswordHash !== null && state.adminPasswordHash === record.adminPasswordHash;
}
