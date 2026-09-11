import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { MetricsSnapshot, UsageEvent } from '../../../packages/contracts/src/index.js';
import { aggregateUsageEvents, isUsageEvent } from '../../../packages/instrumentation/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

const EVENTS_FILE = 'usage-events.jsonl';
const MAX_EVENTS_IN_MEMORY = 100_000;

/** Reads the bounded allowlist emitted by the SillyTavern fetch loader. */
export class MetricsStore {
  private readonly eventsPath: string;

  public constructor(private readonly paths: PlatformPaths) {
    this.eventsPath = join(paths.metrics, EVENTS_FILE);
  }

  public get filePath(): string { return this.eventsPath; }

  public async append(event: UsageEvent): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true });
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  public async snapshot(now = new Date(), days = 30): Promise<MetricsSnapshot> {
    const events: UsageEvent[] = [];
    let replacementIndex = 0;
    const fromTimestamp = now.getTime() - days * 24 * 60 * 60 * 1000;
    try {
      await access(this.eventsPath);
    } catch {
      return aggregateUsageEvents(events, now, days);
    }
    const input = createReadStream(this.eventsPath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (typeof line !== 'string' || line.length > 16 * 1024) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isUsageEvent(parsed) && Date.parse(parsed.timestamp) >= fromTimestamp && Date.parse(parsed.timestamp) <= now.getTime()) {
            if (events.length < MAX_EVENTS_IN_MEMORY) events.push(parsed);
            else { events[replacementIndex] = parsed; replacementIndex = (replacementIndex + 1) % MAX_EVENTS_IN_MEMORY; }
          }
        } catch {
          // A partial line from an interrupted append is ignored until the next write.
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return aggregateUsageEvents(events, now, days);
  }
}
