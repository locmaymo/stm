import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { archiveFormat, packTree, unpackTree, type ArchiveFormat } from '../../platform/src/archive.js';

/**
 * A packed copy of the SillyTavern runtime, kept in the data directory.
 *
 * Used where the runtime lives on a disk that does not outlive the machine and
 * the data directory is network storage: twenty thousand small files written
 * there one by one take minutes, and read back one by one take minutes again.
 * One large file goes at the network's full speed both ways, so the runtime is
 * kept there as a single tar archive and unpacked onto the local disk when the
 * machine comes back empty.
 */

const RECORD_FILE = 'runtime-pack.json';
const PACK_PREFIX = 'runtime-';

export interface RuntimePackRecord {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly revision: string | null;
  readonly file: string;
  readonly format: ArchiveFormat;
  readonly bytes: number;
  readonly createdAt: string;
}

/** The record of the pack in `directory`, or null when there is none to trust. */
export async function readRuntimePack(directory: string): Promise<RuntimePackRecord | null> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(directory, RECORD_FILE), 'utf8')); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<RuntimePackRecord>;
  if (record.schemaVersion !== 1 || typeof record.installationId !== 'string' || typeof record.file !== 'string') return null;
  if (record.format !== 'zst' && record.format !== 'gz') return null;
  if (basename(record.file) !== record.file || !record.file.startsWith(PACK_PREFIX)) return null;
  return record as RuntimePackRecord;
}

/**
 * Pack `runtimePath` into `directory`, and point the record at the new pack.
 *
 * The pack is written under a name of its own and only then named in the
 * record, so a machine that stops halfway leaves the previous pack in charge
 * rather than half of a new one. Nothing large is renamed: on object storage a
 * rename is a copy.
 */
export async function writeRuntimePack(runtimePath: string, directory: string, identity: { readonly installationId: string; readonly revision: string | null }, now: () => Date = () => new Date()): Promise<RuntimePackRecord> {
  await mkdir(directory, { recursive: true });
  const format = archiveFormat();
  const file = `${PACK_PREFIX}${(identity.revision ?? identity.installationId).slice(0, 12)}-${randomBytes(4).toString('hex')}.tar.${format}`;
  const bytes = await packTree(runtimePath, join(directory, file), format);
  const record: RuntimePackRecord = { schemaVersion: 1, installationId: identity.installationId, revision: identity.revision, file, format, bytes, createdAt: now().toISOString() };
  const recordPath = join(directory, RECORD_FILE);
  const temporary = `${recordPath}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, recordPath);
  await removeOtherPacks(directory, file);
  return record;
}

/** Every pack but `keep`, and any record left half-written. */
async function removeOtherPacks(directory: string, keep: string | null): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); } catch { return; }
  await Promise.all(names
    .filter((name) => name !== keep && ((name.startsWith(PACK_PREFIX) && name.includes('.tar.')) || (name.startsWith(RECORD_FILE) && name.endsWith('.tmp'))))
    .map((name) => rm(join(directory, name), { force: true })));
}

/** Throw the pack and its record away. */
export async function removeRuntimePack(directory: string): Promise<void> {
  await rm(join(directory, RECORD_FILE), { force: true });
  await removeOtherPacks(directory, null);
}

/**
 * Unpack `record` from `directory` as `target`.
 *
 * Unpacked beside the target first and moved into place whole, so what is at
 * `target` afterwards is either the complete runtime or nothing at all.
 */
export async function unpackRuntime(directory: string, record: RuntimePackRecord, target: string): Promise<void> {
  const staging = `${target}.unpack-${randomBytes(4).toString('hex')}`;
  await mkdir(dirname(target), { recursive: true });
  await mkdir(staging, { recursive: true });
  try {
    await unpackTree(join(directory, record.file), record.format, staging);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
