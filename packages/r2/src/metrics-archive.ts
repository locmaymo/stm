import type { FileChunk } from './sync.js';
import { R2HttpError, type ObjectStore } from './store.js';

/**
 * Where the record of how much was asked of each provider is kept.
 *
 * It is not profile data - SillyTavern never reads it - so it has no business
 * in a recovery point, where restoring one would write it into somebody's
 * chat directory. It is not settings either: it is an append-only log that
 * grows for as long as the manager is used, which rules out the other shape
 * used here, a small document rewritten whole.
 *
 * So it gets the treatment the profile gets: split into chunks, each named by
 * the hash of its own bytes, with an index naming them in order. Appending to
 * a log changes only the chunk at the end of it, so a run sends one chunk and
 * one index however long the log has grown - which is the whole point of doing
 * it this way rather than uploading the file.
 */
export interface MetricsArchive {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly chunks: readonly FileChunk[];
}

export const METRICS_OBJECT = 'metrics.json';

export async function readMetricsArchive(store: ObjectStore, key: string): Promise<MetricsArchive | null> {
  let body: Buffer;
  try {
    body = await store.getObject(key);
  } catch (error: unknown) {
    if (error instanceof R2HttpError && error.status === 404) return null;
    throw error;
  }
  try {
    return parseMetricsArchive(JSON.parse(body.toString('utf8')));
  } catch {
    return null;
  }
}

export async function writeMetricsArchive(store: ObjectStore, key: string, archive: MetricsArchive): Promise<void> {
  await store.putObject(key, Buffer.from(JSON.stringify(archive), 'utf8'), 'application/json');
}

/**
 * Read an index back, or null when it does not describe a file.
 *
 * The chunks have to be contiguous and in order, because that is the only
 * thing that makes them a file rather than a pile of bytes: a gap or an
 * overlap would be written back as a log that says something different from
 * what was sent.
 */
export function parseMetricsArchive(value: unknown): MetricsArchive | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const updatedAt = typeof record.updatedAt === 'string' && !Number.isNaN(Date.parse(record.updatedAt)) ? record.updatedAt : null;
  if (updatedAt === null || !Array.isArray(record.chunks)) return null;
  const chunks: FileChunk[] = [];
  let offset = 0;
  for (const entry of record.chunks) {
    if (typeof entry !== 'object' || entry === null) return null;
    const chunk = entry as Record<string, unknown>;
    if (typeof chunk.hash !== 'string' || !/^[0-9a-f]{64}$/u.test(chunk.hash)) return null;
    if (typeof chunk.length !== 'number' || !Number.isInteger(chunk.length) || chunk.length <= 0) return null;
    if (chunk.offset !== offset) return null;
    chunks.push({ hash: chunk.hash, offset, length: chunk.length });
    offset += chunk.length;
  }
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isInteger(record.sizeBytes) && record.sizeBytes >= 0 ? record.sizeBytes : offset;
  if (sizeBytes !== offset) return null;
  return { schemaVersion: 1, updatedAt, sizeBytes, chunks };
}
