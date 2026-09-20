import type { ManagerSettingsOffer, ManagerSettingsRecord } from '../../../packages/contracts/src/index.js';
import { logEvent, logLineText, type LogSink } from '../../../packages/contracts/src/index.js';
import type { BackupStore } from '../../../packages/backup/src/index.js';
import type { R2Manager } from '../../../packages/r2/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
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
    adminPasswordHash: state.adminPasswordHash,
    accessPasswordHash: state.accessPasswordHash,
    accessPasscode: state.accessPasscode,
    accessLanEnabled: state.accessLanEnabled,
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
  };
}

/** Put them in the bucket if they have moved since the last time. */
export async function saveManagerSettings(deps: ManagerSettingsDeps): Promise<boolean> {
  return await deps.r2.saveManagerSettings(await currentManagerSettings(deps));
}

/** What the panel is told about settings some machine has left in the bucket. */
export async function managerSettingsOffer(deps: ManagerSettingsDeps): Promise<ManagerSettingsOffer> {
  const record = await deps.r2.loadManagerSettings().catch(() => null);
  if (!record) return { available: false, label: null, writtenAt: null, mine: false, hasAdminPassword: false, hasAccessPassword: false };
  const mine = await isMine(deps, record);
  return {
    available: true,
    label: record.label,
    writtenAt: record.writtenAt,
    mine,
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
      // The console's own door. `changeAdminPassword` replaces an existing
      // hash; `bootstrapAdminPassword` sets a first one. A machine restoring
      // settings may be in either state.
      const changed = await deps.store.changeAdminPassword(record.adminPasswordHash);
      if (!changed) await deps.store.bootstrapAdminPassword(record.adminPasswordHash);
      applied.push('managerPassword');
    } else skipped.push('managerPassword');
    if (record.accessPasswordHash) {
      await deps.store.setAccessPassword(record.accessPasswordHash, record.accessPasscode);
      applied.push('accessPassword');
    } else skipped.push('accessPassword');
    await deps.store.setAccessLan(record.accessLanEnabled);
    applied.push('accessNetwork');
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
    applied.push('sillyTavernPort');
  } catch (error: unknown) {
    // Held by something else here, or out of range. The manager keeps the port
    // it already had, which is one that works on this machine.
    if (!(error instanceof PortError)) throw error;
    skipped.push('sillyTavernPort');
  }

  logger(logEvent('r2.settingsRestored', `[r2] restored the manager’s settings from ${record.label}: ${applied.join(', ') || 'nothing'}`, { from: record.label, applied: applied.join(', ') }));
  return { applied, skipped };
}

/** Whether the record in the bucket is the one this installation wrote. */
async function isMine(deps: ManagerSettingsDeps, record: ManagerSettingsRecord): Promise<boolean> {
  const state = await deps.store.getPersisted();
  // The hash is what makes it this machine's: two installations never share
  // one, and the label is only a hostname, which two machines can share.
  return state.adminPasswordHash !== null && state.adminPasswordHash === record.adminPasswordHash;
}
