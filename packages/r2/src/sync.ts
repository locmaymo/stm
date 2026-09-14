import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ProfileLayout } from '../../contracts/src/index.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * How much of a file one stored object holds.
 *
 * A chat is a JSONL file that only ever grows at the end, so cutting at a fixed
 * offset means every chunk before the last one keeps the hash it had: a reply
 * appended to a 30 MB chat uploads the tail, not the chat. That is the whole
 * reason a fixed size is enough here and content-defined chunking is not worth
 * its cost - nothing in a profile rewrites a file from the middle.
 *
 * Most files are far smaller than this and are one chunk, which is the cheap
 * case: one hash, one object, and nothing uploaded at all when it has not
 * changed.
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/** A stored object holds one byte saying how the rest of it is encoded. */
const BLOB_RAW = 0x00;
const BLOB_GZIP = 0x01;

/**
 * Extensions whose content is already compressed.
 *
 * Running deflate over a PNG spends CPU on every backup to make the object very
 * slightly larger. The list is about what the bytes are, not about what
 * SillyTavern calls them.
 */
const INCOMPRESSIBLE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico',
  'mp4', 'webm', 'mkv', 'mov', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'br', '7z', 'rar',
  'woff', 'woff2', 'onnx', 'safetensors', 'pdf',
]);

export interface FileChunk {
  /** SHA-256 of the raw bytes, which is also the object's name in the bucket. */
  readonly hash: string;
  readonly offset: number;
  readonly length: number;
}

export interface HashedFile {
  /** Archive-relative path with forward slashes, the same name a ZIP entry carries. */
  readonly name: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly chunks: readonly FileChunk[];
}

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * What one backup point is: a list of names and the content each one had.
 *
 * It holds no data of its own, only hashes, so it stays small enough to upload
 * on every run - a profile of eleven thousand chats is a couple of hundred
 * kilobytes once gzipped. Two snapshots taken a day apart share every chunk
 * neither of them changed, which is what makes keeping many of them affordable.
 */
export interface R2Snapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly layout: ProfileLayout;
  /** The profile fingerprint this was taken at, so an unchanged profile is skipped. */
  readonly fingerprint: string;
  readonly files: readonly HashedFile[];
}

export class SyncError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Whether this name is worth spending deflate on. */
export function shouldCompress(name: string): boolean {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(name)?.[1]?.toLowerCase();
  return extension === undefined || !INCOMPRESSIBLE.has(extension);
}

/**
 * Where one chunk lives in the bucket.
 *
 * The first two characters of the hash become a directory so that no single
 * listing has to page through every chunk in the profile.
 */
export function blobKey(prefix: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new SyncError('invalid_blob_hash', 'A blob hash must be 64 hexadecimal characters');
  return `${prefix}blobs/${hash.slice(0, 2)}/${hash}`;
}

/** Where one snapshot lives, newest last in a listing because the name sorts by time. */
export function snapshotKey(prefix: string, profileId: string, snapshotId: string): string {
  return `${prefix}snapshots/${profileId}/${snapshotId}.json.gz`;
}

/**
 * The bytes to store for one chunk, with the byte that says how to read them.
 *
 * Compression is offered rather than imposed: deflate can make an already dense
 * chunk larger, and a stored object that is bigger than the data it holds is
 * the one outcome this must never produce.
 */
export async function encodeBlob(raw: Buffer, compress: boolean): Promise<Buffer> {
  if (compress) {
    const packed = await gzipAsync(raw);
    if (packed.byteLength < raw.byteLength) return Buffer.concat([Buffer.from([BLOB_GZIP]), packed]);
  }
  return Buffer.concat([Buffer.from([BLOB_RAW]), raw]);
}

export async function decodeBlob(stored: Buffer): Promise<Buffer> {
  if (stored.byteLength < 1) throw new SyncError('empty_blob', 'A stored chunk is empty');
  const encoding = stored[0];
  const payload = stored.subarray(1);
  if (encoding === BLOB_RAW) return Buffer.from(payload);
  if (encoding === BLOB_GZIP) return await gunzipAsync(payload);
  throw new SyncError('unknown_blob_encoding', `A stored chunk uses encoding ${String(encoding)}, which this manager cannot read`);
}

export async function encodeSnapshot(snapshot: R2Snapshot): Promise<Buffer> {
  return await gzipAsync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
}

export async function decodeSnapshot(stored: Buffer): Promise<R2Snapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await gunzipAsync(stored)).toString('utf8'));
  } catch (error: unknown) {
    throw new SyncError('unreadable_snapshot', `A stored snapshot could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return parseSnapshot(parsed);
}

export function parseSnapshot(value: unknown): R2Snapshot {
  if (!isRecord(value)) throw new SyncError('unreadable_snapshot', 'A stored snapshot is not an object');
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new SyncError('unsupported_snapshot', 'A stored snapshot uses a schema this manager cannot read');
  const files = value.files;
  if (!Array.isArray(files)) throw new SyncError('unreadable_snapshot', 'A stored snapshot carries no file list');
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id: requireString(value.id, 'id'),
    createdAt: requireString(value.createdAt, 'createdAt'),
    profileId: requireString(value.profileId, 'profileId'),
    profileName: requireString(value.profileName, 'profileName'),
    layout: value.layout === 'public' ? 'public' : 'data',
    fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : '',
    files: files.map((file) => parseHashedFile(file)),
  };
}

/**
 * Read one file as the chunks it is made of, or report that it is gone.
 *
 * The walk that produced the name finished before this runs and the profile
 * does not hold still: SillyTavern deletes a character the moment the operator
 * does. A file that is no longer there is skipped, the same way the archive
 * writer skips it, rather than failing the whole backup.
 */
export async function hashFile(name: string, path: string): Promise<HashedFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error: unknown) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
  try {
    const details = await handle.stat();
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const chunks: FileChunk[] = [];
    let offset = 0;
    for (;;) {
      const length = await readFully(handle, buffer, offset);
      if (length === 0) break;
      chunks.push({ hash: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'), offset, length });
      offset += length;
      if (length < CHUNK_BYTES) break;
    }
    return { name, sizeBytes: offset, mtimeMs: Math.floor(details.mtimeMs), chunks };
  } catch (error: unknown) {
    if (isFileNotFound(error)) return null;
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Whether a file still holds what a snapshot said it held.
 *
 * Size and modification time are one stat rather than a read of the whole file,
 * which is what lets a five-minute backup walk a profile of gigabytes without
 * touching its content. It is the same trade every incremental backup makes:
 * a file rewritten with identical size inside the same millisecond is missed,
 * and the periodic full pass is what catches that.
 */
export function looksUnchanged(previous: HashedFile | undefined, sizeBytes: number, mtimeMs: number): previous is HashedFile {
  return previous !== undefined && previous.sizeBytes === sizeBytes && previous.mtimeMs === Math.floor(mtimeMs);
}

/** Every chunk hash a set of snapshots still refers to, for deciding what may be deleted. */
export function referencedHashes(snapshots: readonly R2Snapshot[]): Set<string> {
  const hashes = new Set<string>();
  for (const snapshot of snapshots) for (const file of snapshot.files) for (const chunk of file.chunks) hashes.add(chunk.hash);
  return hashes;
}

/** What one snapshot would occupy if nothing else shared its chunks. */
export function snapshotBytes(snapshot: R2Snapshot): number {
  let total = 0;
  for (const file of snapshot.files) total += file.sizeBytes;
  return total;
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let filled = 0;
  while (filled < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

function parseHashedFile(value: unknown): HashedFile {
  if (!isRecord(value)) throw new SyncError('unreadable_snapshot', 'A stored snapshot holds an entry that is not an object');
  const chunks = value.chunks;
  if (!Array.isArray(chunks)) throw new SyncError('unreadable_snapshot', 'A stored snapshot entry carries no chunk list');
  return {
    name: requireString(value.name, 'name'),
    sizeBytes: requireNumber(value.sizeBytes, 'sizeBytes'),
    mtimeMs: requireNumber(value.mtimeMs, 'mtimeMs'),
    chunks: chunks.map((chunk) => parseChunk(chunk)),
  };
}

function parseChunk(value: unknown): FileChunk {
  if (!isRecord(value)) throw new SyncError('unreadable_snapshot', 'A stored snapshot holds a chunk that is not an object');
  const hash = requireString(value.hash, 'hash');
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new SyncError('unreadable_snapshot', 'A stored snapshot holds a chunk with an invalid hash');
  return { hash, offset: requireNumber(value.offset, 'offset'), length: requireNumber(value.length, 'length') };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new SyncError('unreadable_snapshot', `A stored snapshot is missing its ${field}`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SyncError('unreadable_snapshot', `A stored snapshot has an invalid ${field}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'EISDIR');
}
