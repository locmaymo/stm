import { WORKER_SOURCE } from '../src/worker-script.js';

/** Just enough of an R2 binding to run the Worker against. */
export class MemoryBucket {
  public readonly objects = new Map<string, { body: Uint8Array; contentType: string | undefined }>();

  public async put(key: string, body: ReadableStream | null, options?: { httpMetadata?: { contentType?: string } }): Promise<{ size: number; etag: string }> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { body: bytes, contentType: options?.httpMetadata?.contentType });
    return { size: bytes.byteLength, etag: `etag-${bytes.byteLength}` };
  }

  public async get(key: string): Promise<{ body: ReadableStream; size: number } | null> {
    const stored = this.objects.get(key);
    return stored ? { body: new Response(stored.body as BodyInit).body as ReadableStream, size: stored.body.byteLength } : null;
  }

  public async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  public async list(options: { prefix: string; limit: number; cursor?: string }): Promise<{ objects: Array<{ key: string; size: number; etag: string; uploaded: Date }>; truncated: boolean; cursor?: string }> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = keys.slice(start, start + options.limit);
    const truncated = start + page.length < keys.length;
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)?.body.byteLength ?? 0, etag: 'e', uploaded: new Date('2026-09-16T00:00:00Z') })),
      truncated,
      ...(truncated ? { cursor: String(start + page.length) } : {}),
    };
  }
}

export interface WorkerModule {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

/** The deployed source, loaded the way the Workers runtime would: as an ES module. */
export async function loadWorker(): Promise<WorkerModule> {
  const module = await import(`data:text/javascript;base64,${Buffer.from(WORKER_SOURCE, 'utf8').toString('base64')}`) as { default: WorkerModule };
  return module.default;
}

/** A fetch that delivers every request to the Worker, as workers.dev would. */
export function workerFetch(worker: WorkerModule, env: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input instanceof URL ? input.toString() : String(input), { ...init, ...(init?.body ? { duplex: 'half' } : {}) } as RequestInit);
    return await worker.fetch(request, env);
  };
}
