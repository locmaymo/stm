import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';

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

export type PackFormat = 'zst' | 'gz';

export interface RuntimePackRecord {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly revision: string | null;
  readonly file: string;
  readonly format: PackFormat;
  readonly bytes: number;
  readonly createdAt: string;
}

interface ZstdZlib {
  readonly createZstdCompress?: (options?: object) => Transform;
  readonly createZstdDecompress?: () => Transform;
}

/** Zstandard where this Node has it, which is faster both ways; gzip otherwise. */
function preferredFormat(): PackFormat {
  return typeof (zlib as ZstdZlib).createZstdCompress === 'function' ? 'zst' : 'gz';
}

function compressor(format: PackFormat): Transform {
  const zstd = (zlib as ZstdZlib).createZstdCompress;
  if (format === 'zst' && zstd) return zstd();
  return zlib.createGzip({ level: 1 });
}

function decompressor(format: PackFormat): Transform {
  if (format === 'gz') return zlib.createGunzip();
  const zstd = (zlib as ZstdZlib).createZstdDecompress;
  if (!zstd) throw new Error('this Node cannot read a Zstandard archive');
  return zstd();
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
 * A directory as `tar` should be given it. Forward slashes on Windows, where
 * the tar first on the path may be a POSIX one that reads a backslash as an
 * escape; Windows' own tar takes them as well.
 */
function tarPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/gu, '/') : path;
}

/** Start `tar` with `args`; `done` settles when it exits, rejecting with what it said if it failed. */
function startTar(args: readonly string[], withInput: boolean): { child: ChildProcess; done: Promise<void> } {
  const child = spawn('tar', [...args], { stdio: [withInput ? 'pipe' : 'ignore', withInput ? 'ignore' : 'pipe', 'pipe'], windowsHide: true });
  let errorText = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-2000); });
  const done = new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code ?? 'a signal'}${errorText.trim() ? `: ${errorText.trim()}` : ''}`)));
  });
  return { child, done };
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
  const format = preferredFormat();
  const file = `${PACK_PREFIX}${(identity.revision ?? identity.installationId).slice(0, 12)}-${randomBytes(4).toString('hex')}.tar.${format}`;
  const target = join(directory, file);
  try {
    const tar = startTar(['-C', tarPath(runtimePath), '-cf', '-', '.'], false);
    if (!tar.child.stdout) throw new Error('tar gave no output');
    await Promise.all([pipeline(tar.child.stdout, compressor(format), createWriteStream(target, { mode: 0o600 })), tar.done]);
  } catch (error: unknown) {
    await rm(target, { force: true });
    throw error;
  }
  const record: RuntimePackRecord = { schemaVersion: 1, installationId: identity.installationId, revision: identity.revision, file, format, bytes: (await stat(target)).size, createdAt: now().toISOString() };
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
    const unpacked = decompressor(record.format);
    const tar = startTar(['-C', tarPath(staging), '-xf', '-'], true);
    if (!tar.child.stdin) throw new Error('tar took no input');
    await Promise.all([pipeline(createReadStream(join(directory, record.file)), unpacked, tar.child.stdin), tar.done]);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
