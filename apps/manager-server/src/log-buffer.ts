import { stripVTControlCharacters } from 'node:util';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';
import { isLogEvent, type LogEntry, type LogLine } from '../../../packages/contracts/src/index.js';

export const LOG_LIMITS = {
  // Deep enough that the whole of a long restore, and the SillyTavern start
  // that follows it, are still scrollable afterwards. At the average line this
  // is a few megabytes of resident memory.
  entries: 25_000,
  messageCharacters: 4_096,
  totalCharacters: 8 * 1024 * 1024,
  responseEntries: 500,
  historyEntries: 300,
} as const;

/** Recent local output only. Durable log rotation belongs to the supervisor. */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private characters = 0;
  private nextId = 1;
  private readonly streamId = randomUUID();
  private writeQueue: Promise<void> = Promise.resolve();
  private durableBytes = 0;
  private durableReady = false;

  public constructor(private readonly paths?: PlatformPaths, private readonly mirror?: (line: string) => void) {}

  public append(source: LogEntry['source'], line: LogLine, level: LogEntry['level'] = 'info'): void {
    let clean = stripVTControlCharacters(isLogEvent(line) ? line.message : line).trim();
    if (!clean) return;
    if (clean.length > LOG_LIMITS.messageCharacters) {
      clean = clean.slice(0, LOG_LIMITS.messageCharacters - 1);
      const last = clean.charCodeAt(clean.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1);
      clean += '…';
    }
    const translation = isLogEvent(line) ? { code: line.code, ...(line.params ? { params: line.params } : {}) } : {};
    const entry: LogEntry = { id: this.nextId++, timestamp: new Date().toISOString(), source, level, message: clean, ...translation };
    this.entries.push(entry);
    this.characters += clean.length;
    while (this.entries.length > LOG_LIMITS.entries || this.characters > LOG_LIMITS.totalCharacters) {
      this.characters -= this.entries.shift()!.message.length;
    }
    if (level !== 'info' || source === 'manager') this.mirror?.(`[${source}] ${clean}`);
    if (this.paths) this.persist(entry);
  }

  /**
   * What has been said since `after`, and where to ask from next.
   *
   * One answer is capped, and the two readers of that cap want opposite ends.
   * A console that has just opened wants the end of the buffer - replaying
   * twenty-five thousand retained lines to fill a card is neither useful nor
   * cheap. A console that is following wants the next page in order from where
   * it left off.
   *
   * The cursor used to be set to the newest line either way, which meant the
   * lines the cap dropped were never asked for again: an installer saying more
   * than five hundred things between two polls lost the middle of what it
   * said, silently, and the log read as though those minutes had been quiet.
   * A truncated answer now stops the cursor at the last line it carried, so
   * the rest arrives on the polls that follow.
   */
  public read(after: number, source: LogEntry['source'] | null): { streamId: string; entries: LogEntry[]; nextCursor: number } {
    const matching = this.entries.filter((entry) => entry.id > after && (!source || entry.source === source));
    const entries = after === 0
      ? matching.slice(-LOG_LIMITS.responseEntries)
      : matching.slice(0, LOG_LIMITS.responseEntries);
    const last = entries.at(-1)?.id;
    return {
      streamId: this.streamId,
      entries,
      // Only a page that left something behind holds the cursor back. An
      // answer that carried everything says so, which is what stops a reader
      // asking again for lines about a source nothing has written to.
      nextCursor: entries.length < matching.length && last !== undefined ? last : this.nextId - 1,
    };
  }

  /**
   * The page of retained lines that precedes `before`, newest last.
   *
   * `hasMore` reports whether anything older is still held, so a reader can
   * stop asking once it reaches the start of the buffer rather than polling a
   * boundary it cannot cross.
   */
  public readBefore(before: number, source: LogEntry['source'] | null, limit: number): { streamId: string; entries: LogEntry[]; hasMore: boolean } {
    const matching = this.entries.filter((entry) => (!source || entry.source === source) && (before <= 0 || entry.id < before));
    const size = Math.max(1, Math.min(limit, LOG_LIMITS.historyEntries));
    return {
      streamId: this.streamId,
      entries: matching.slice(-size),
      hasMore: matching.length > size,
    };
  }

  private persist(entry: LogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.paths) return;
      if (!this.durableReady) { await mkdir(this.paths.logs, { recursive: true }); try { this.durableBytes = (await stat(join(this.paths.logs, 'manager.log'))).size; } catch { this.durableBytes = 0; } this.durableReady = true; }
      if (this.durableBytes + Buffer.byteLength(line) > 5 * 1024 * 1024) {
        for (let index = 3; index >= 1; index -= 1) {
          const from = join(this.paths!.logs, index === 1 ? 'manager.log' : `manager.log.${index - 1}`);
          const to = join(this.paths!.logs, `manager.log.${index}`);
          try { const { rename } = await import('node:fs/promises'); await rename(from, to); } catch { /* file may not exist */ }
        }
        this.durableBytes = 0;
      }
      await appendFile(join(this.paths.logs, 'manager.log'), line, { encoding: 'utf8', mode: 0o600 });
      this.durableBytes += Buffer.byteLength(line);
    }).catch(() => undefined);
  }
}
