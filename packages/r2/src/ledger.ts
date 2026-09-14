import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * How much slack is tolerated before the file is rewritten.
 *
 * Lines are only ever appended, so a bucket that has been pruned many times
 * accumulates hashes that no longer exist anywhere. Compaction is a rewrite of
 * the whole file, which is cheap but not free, so it waits until the waste is
 * worth the write.
 */
const COMPACT_RATIO = 1.5;
const COMPACT_FLOOR = 4096;

/**
 * What this manager has already put in the bucket.
 *
 * Deciding whether a chunk needs uploading is the question a backup asks
 * thousands of times per run, and asking R2 costs either a request per chunk or
 * a listing of the whole store. Both are charged operations, and on a
 * five-minute schedule either one is the dominant cost of the whole design. So
 * the answer is kept here instead: an append-only list of hashes, loaded once
 * into a set.
 *
 * It is a cache, not the record of truth - the bucket is. A hash missing from
 * here costs one redundant upload of a chunk that was already there. A hash
 * here that is not in the bucket is the dangerous direction, so nothing is
 * written until the upload that put it there has succeeded, and a periodic
 * listing replaces the whole file with what the bucket actually holds.
 */
export class BlobLedger {
  private readonly path: string;
  private readonly hashes = new Set<string>();
  private loaded = false;
  /** Lines on disk, including ones for hashes since dropped, to decide on compaction. */
  private lines = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: { readonly path: string }) {
    this.path = options.path;
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      // No ledger yet, or one that cannot be read. Either way the bucket is
      // still the truth: the cost is re-uploading chunks it already holds.
      return;
    }
    for (const line of raw.split('\n')) {
      const hash = line.trim();
      // A process killed mid-append leaves a partial last line. Dropping
      // anything that is not a hash is enough to recover from that.
      if (/^[0-9a-f]{64}$/u.test(hash)) this.hashes.add(hash);
      if (hash) this.lines += 1;
    }
  }

  public has(hash: string): boolean {
    return this.hashes.has(hash);
  }

  public get size(): number {
    return this.hashes.size;
  }

  /** Record chunks that are now in the bucket. Call this only after the upload succeeded. */
  public async add(hashes: readonly string[]): Promise<void> {
    await this.load();
    const fresh = hashes.filter((hash) => !this.hashes.has(hash));
    if (fresh.length === 0) return;
    for (const hash of fresh) this.hashes.add(hash);
    this.lines += fresh.length;
    await this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${fresh.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    if (this.lines > COMPACT_FLOOR && this.lines > this.hashes.size * COMPACT_RATIO) await this.rewrite();
  }

  /** Forget chunks that are no longer in the bucket, so a later run uploads them again. */
  public async forget(hashes: Iterable<string>): Promise<void> {
    await this.load();
    let removed = false;
    for (const hash of hashes) removed = this.hashes.delete(hash) || removed;
    if (removed) await this.rewrite();
  }

  /** Replace the cache with what a listing says the bucket actually holds. */
  public async reconcile(hashes: Iterable<string>): Promise<void> {
    this.loaded = true;
    this.hashes.clear();
    for (const hash of hashes) if (/^[0-9a-f]{64}$/u.test(hash)) this.hashes.add(hash);
    await this.rewrite();
  }

  private async rewrite(): Promise<void> {
    const snapshot = [...this.hashes];
    this.lines = snapshot.length;
    await this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, snapshot.length ? `${snapshot.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.path);
      } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Writes run one at a time, so an append never interleaves with a rewrite. */
  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}
