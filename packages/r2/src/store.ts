/**
 * What the manager needs from wherever its objects live.
 *
 * R2 can be reached three ways - the S3 API with keys, a Worker in the user's
 * account, or Cloudflare's REST API - and they differ in how requests are
 * authenticated and how fast they may go, not in what they can do. The manager
 * speaks to this, so the way a bucket was connected changes nothing above it.
 */
export interface ObjectStore {
  listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }>;
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
  /**
   * Finish sending whatever `putObject` accepted but has not stored yet.
   *
   * Only for a store that gathers small objects before sending them (Google
   * Drive's packs). A caller records objects as stored only after this.
   */
  flush?(): Promise<void>;
  /** Take back space held by deleted objects that a store keeps inside bigger ones. */
  compact?(): Promise<{ readonly removedPacks: number; readonly rewrittenPacks: number; readonly gatheredFiles: number }>;
  /**
   * Store an object only if nothing holds its key yet; false when something does.
   *
   * Only for a store that can refuse the write itself. Without it a slot is
   * taken by looking first and looking again afterwards; see `slot.ts`.
   */
  putIfAbsent?(key: string, body: Uint8Array, contentType: string): Promise<boolean>;
  /**
   * Take a slot the store's own way, for a store where one key can hold the
   * attempts of several writers side by side (Google Drive). See `slot.ts`.
   */
  claimSlot?(key: string, body: Uint8Array, timing: SlotTiming): Promise<SlotResult>;
  /** What holds a slot, read the same way `claimSlot` decides it. */
  readSlot?(key: string): Promise<Buffer | null>;
}

/** How long a writer waits before it believes what it sees in a slot. */
export interface SlotTiming {
  /** Waited between writing and looking, so a writer that started at the same moment has landed. */
  readonly settleMs: number;
  /** A write that took longer than this may have landed after others stopped looking, and is withdrawn. */
  readonly stallMs: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

export interface SlotResult {
  readonly won: boolean;
  /** What the slot holds now, or null when this writer withdrew and nobody else was there. */
  readonly holder: Buffer | null;
}

/**
 * How Cloudflare bills a request: Class A, Class B, or nothing.
 *
 * Listing is Class A, the same as a write, which is why it counts as charged.
 */
export type Billing = 'charged' | 'read' | 'free';

export interface ObjectRecord {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

export class R2Error extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class R2HttpError extends R2Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super('r2_request_failed', message);
    this.status = status;
  }
}
