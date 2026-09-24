import { KEEP_ONLINE_DEFAULT_MINUTES, KEEP_ONLINE_MAX_MINUTES, KEEP_ONLINE_MIN_MINUTES, parseAccessLinks, type ManagerSettingsRecord } from '../../contracts/src/index.js';
import { R2HttpError, type ObjectStore } from './store.js';

/**
 * Where the manager's own settings sit in the bucket.
 *
 * Beside `owner.json` and `usage.json` rather than among the recovery points,
 * because it is not one: it describes the machine rather than the data, there
 * is one of it, and it is replaced rather than accumulated. Keeping it out of
 * `snapshots/` also keeps it out of retention, which thins recovery points on
 * a schedule and would eventually throw this away.
 */
export const MANAGER_SETTINGS_OBJECT = 'manager.json';

/**
 * The record this bucket held before the machine using it changed.
 *
 * One bucket describes one machine, so a machine that takes the bucket writes
 * its own settings over whatever was there - which is right, and which was
 * destroying the only copy of the thing the console was in the middle of
 * offering to put back. The window was one scheduler tick: sign in, and about
 * a minute later the card still said "this account holds the setup of
 * <the old machine>" while the record behind it had already become this
 * machine's own.
 *
 * So the one being replaced is copied here first, and only when the
 * replacement comes from a different installation. It is written on a handover
 * and never otherwise, it holds exactly one record, and it is what the console
 * falls back to when the current record turns out to be this machine's.
 */
export const MANAGER_SETTINGS_PREVIOUS_OBJECT = 'manager-previous.json';

/**
 * How often the settings are written when nothing about them has changed.
 *
 * Almost never, in practice: the write happens when the settings differ from
 * what was last sent, and these are things somebody changes by hand. The
 * interval is a floor under a pathological case - a setting that flaps - not a
 * schedule.
 */
export const MANAGER_SETTINGS_MIN_INTERVAL_MS = 10 * 60 * 1000;

export async function readManagerSettings(store: ObjectStore, key: string): Promise<ManagerSettingsRecord | null> {
  let body: Buffer;
  try {
    body = await store.getObject(key);
  } catch (error: unknown) {
    if (error instanceof R2HttpError && error.status === 404) return null;
    throw error;
  }
  try {
    return parseManagerSettings(JSON.parse(body.toString('utf8')));
  } catch {
    return null;
  }
}

export async function writeManagerSettings(store: ObjectStore, key: string, record: ManagerSettingsRecord): Promise<void> {
  await store.putObject(key, Buffer.from(JSON.stringify(record), 'utf8'), 'application/json');
}

/**
 * Read a record back, or null when there is nothing usable in it.
 *
 * Every field is checked rather than trusted, because what comes back decides
 * what a console's password is and which port SillyTavern is started on. A
 * field that is missing or the wrong shape falls back to what this manager
 * would have done anyway; a record with no recognisable timestamp is not a
 * record.
 */
export function parseManagerSettings(value: unknown): ManagerSettingsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const writtenAt = typeof record.writtenAt === 'string' && !Number.isNaN(Date.parse(record.writtenAt)) ? record.writtenAt : null;
  if (writtenAt === null) return null;
  const r2 = typeof record.r2 === 'object' && record.r2 !== null ? record.r2 as Record<string, unknown> : {};
  return {
    schemaVersion: 1,
    label: text(record.label) ?? 'another machine',
    installId: text(record.installId),
    writtenAt,
    adminPasswordHash: text(record.adminPasswordHash),
    accessPasswordHash: text(record.accessPasswordHash),
    accessPasscode: record.accessPasscode === true,
    accessLanEnabled: record.accessLanEnabled === true,
    tunnelQuick: record.tunnelQuick === true,
    managerTunnelQuick: record.managerTunnelQuick === true,
    autoStartSillyTavern: record.autoStartSillyTavern !== false,
    keepOnline: record.keepOnline !== false,
    keepOnlineMinutes: whole(record.keepOnlineMinutes, KEEP_ONLINE_MIN_MINUTES, KEEP_ONLINE_MAX_MINUTES) ?? KEEP_ONLINE_DEFAULT_MINUTES,
    sillyTavernPort: whole(record.sillyTavernPort, 1, 65_535) ?? 8002,
    localIntervalMinutes: whole(record.localIntervalMinutes, 0, 7 * 24 * 60) ?? 0,
    r2: {
      hotIntervalMinutes: whole(r2.hotIntervalMinutes, 1, 7 * 24 * 60) ?? 5,
      coldIntervalHours: whole(r2.coldIntervalHours, 1, 30 * 24) ?? 6,
      reconcileIntervalHours: whole(r2.reconcileIntervalHours, 1, 30 * 24) ?? 24,
      keepRecent: whole(r2.keepRecent, 1, 1000) ?? 24,
      keepDaily: whole(r2.keepDaily, 0, 365) ?? 30,
      keepWeekly: whole(r2.keepWeekly, 0, 520) ?? 0,
      maxStorageBytes: whole(r2.maxStorageBytes, 1024 * 1024, 1024 ** 4) ?? 8_000_000_000,
      maxWriteOperations: whole(r2.maxWriteOperations, 1000, 1_000_000_000) ?? 800_000,
      maxReadOperations: whole(r2.maxReadOperations, 1000, 1_000_000_000) ?? 8_000_000,
    },
    versionSelector: text(record.versionSelector),
    versionRef: text(record.versionRef),
    ...(record.accessLinks !== undefined ? { accessLinks: parseAccessLinks(record.accessLinks) } : {}),
  };
}

/**
 * Whether two records say the same thing, ignoring when they were said.
 *
 * What decides whether a write is worth making: the timestamp and the machine
 * change on every start, and writing for that alone would mean a charged
 * operation every time anybody restarted the manager.
 */
export function settingsUnchanged(left: ManagerSettingsRecord | null, right: ManagerSettingsRecord): boolean {
  if (!left) return false;
  const strip = (record: ManagerSettingsRecord): string => JSON.stringify({ ...record, label: '', installId: '', writtenAt: '' });
  return strip(left) === strip(right);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 512) : null;
}

function whole(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}
