import { stripVTControlCharacters } from 'node:util';
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

  public append(source: LogEntry['source'], message: string, level: LogEntry['level'] = 'info'): void {
    let clean = stripVTControlCharacters(message).trim();
    if (!clean) return;
    if (clean.length > LOG_LIMITS.messageCharacters) {
      clean = clean.slice(0, LOG_LIMITS.messageCharacters - 1);
      const last = clean.charCodeAt(clean.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1);
      clean += '…';
    }
    this.entries.push({ id: this.nextId++, timestamp: new Date().toISOString(), source, level, message: clean });
    this.characters += clean.length;
    while (this.entries.length > LOG_LIMITS.entries || this.characters > LOG_LIMITS.totalCharacters) {
      this.characters -= this.entries.shift()!.message.length;
    }
  }

  public read(after: number, source: LogEntry['source'] | null): { entries: LogEntry[]; nextCursor: number } {
    return {
      entries: this.entries.filter((entry) => entry.id > after && (!source || entry.source === source)).slice(-LOG_LIMITS.responseEntries),
      nextCursor: this.nextId - 1,
    };
  }
}
