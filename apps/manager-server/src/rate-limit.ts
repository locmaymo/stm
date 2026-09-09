interface AttemptWindow {
  readonly timestamps: number[];
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, AttemptWindow>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  public constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? 10;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  public check(key: string): RateLimitResult {
    const now = this.now();
    const window = this.windows.get(key) ?? { timestamps: [] };
    while (window.timestamps[0] !== undefined && window.timestamps[0] <= now - this.windowMs) {
      window.timestamps.shift();
    }
    if (window.timestamps.length >= this.limit) {
      const oldest = window.timestamps[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    window.timestamps.push(now);
    this.windows.set(key, window);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public clear(key: string): void {
    this.windows.delete(key);
  }
}
