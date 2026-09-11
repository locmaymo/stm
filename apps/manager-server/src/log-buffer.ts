import { stripVTControlCharacters } from 'node:util';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';
import type { LogEntry } from '../../../packages/contracts/src/index.js';

export const LOG_LIMITS = {
  entries: 3_000,
  messageCharacters: 4_096,
  totalCharacters: 1_048_576,
  responseEntries: 500,
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

  public append(source: LogEntry['source'], message: string, level: LogEntry['level'] = 'info'): void {
    let clean = stripVTControlCharacters(message).trim();
    if (!clean) return;
    if (clean.length > LOG_LIMITS.messageCharacters) {
      clean = clean.slice(0, LOG_LIMITS.messageCharacters - 1);
      const last = clean.charCodeAt(clean.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1);
      clean += '…';
    }
    const entry: LogEntry = { id: this.nextId++, timestamp: new Date().toISOString(), source, level, message: clean };
    this.entries.push(entry);
    this.characters += clean.length;
    while (this.entries.length > LOG_LIMITS.entries || this.characters > LOG_LIMITS.totalCharacters) {
      this.characters -= this.entries.shift()!.message.length;
    }
    if (level !== 'info' || source === 'manager') this.mirror?.(`[${source}] ${clean}`);
    if (this.paths) this.persist(entry);
  }

  public read(after: number, source: LogEntry['source'] | null): { streamId: string; entries: LogEntry[]; nextCursor: number } {
    return {
      streamId: this.streamId,
      entries: this.entries.filter((entry) => entry.id > after && (!source || entry.source === source)).slice(-LOG_LIMITS.responseEntries),
      nextCursor: this.nextId - 1,
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
