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
