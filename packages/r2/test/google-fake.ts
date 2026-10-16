import { createHash, randomBytes } from 'node:crypto';

/**
 * An in-memory Google: the token broker, the revoke endpoint, and the parts of
 * the Drive API the manager speaks. Queries are understood only in the shapes
 * the manager writes them.
 */

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  content: Buffer;
  modifiedTime: string;
  appProperties: Record<string, string>;
  trashed: boolean;
}

export interface FakeGoogle {
  readonly fetchImpl: typeof fetch;
  readonly files: Map<string, FakeFile>;
  readonly calls: { list: number; create: number; update: number; download: number; remove: number; refresh: number; exchange: number; revoke: number; about: number };
  /** Codes the fake authorization server has handed out, with their PKCE challenges. */
  issueCode(challenge: string): string;
  /** Answer the next N Drive calls with this status first. */
  failNext(status: number, count?: number, reason?: string): void;
  /** Make every access token issued so far stop working. */
  expireAccessTokens(): void;
  revokeAll(): void;
  readonly email: string;
}

export function fakeGoogle(options: { email?: string; brokerOrigin?: string } = {}): FakeGoogle {
  const email = options.email ?? 'tester@example.com';
  const brokerOrigin = options.brokerOrigin ?? 'https://broker.example';
  const files = new Map<string, FakeFile>();
  const codes = new Map<string, string>();
  const refreshTokens = new Set<string>();
  let accessTokens = new Set<string>();
  const calls = { list: 0, create: 0, update: 0, download: 0, remove: 0, refresh: 0, exchange: 0, revoke: 0, about: 0 };
  const failures: Array<{ status: number; reason: string }> = [];
  let clock = Date.parse('2026-10-16T00:00:00.000Z');

  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tick = (): string => new Date((clock += 1000)).toISOString();
  const issueAccess = (): string => { const token = `ya-test-${randomBytes(6).toString('hex')}`; accessTokens.add(token); return token; };
  const view = (file: FakeFile): Record<string, unknown> => ({ id: file.id, name: file.name, size: String(file.content.byteLength), modifiedTime: file.modifiedTime, md5Checksum: createHash('md5').update(file.content).digest('hex') });

  const matches = (file: FakeFile, query: string): boolean => {
    if (/trashed = false/u.test(query) && file.trashed) return false;
    const folderOnly = /mimeType = 'application\/vnd\.google-apps\.folder'/u.test(query);
    const noFolders = /mimeType != 'application\/vnd\.google-apps\.folder'/u.test(query);
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    if (folderOnly && !isFolder) return false;
    if (noFolders && isFolder) return false;
    const property = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/u.exec(query);
    if (property && file.appProperties[property[1] ?? ''] !== property[2]) return false;
    const name = /name = '((?:\\.|[^'\\])*)'/u.exec(query);
    if (name && file.name !== unescape(name[1] ?? '')) return false;
    const parents = [...query.matchAll(/'((?:\\.|[^'\\])*)' in parents/gu)].map((match) => unescape(match[1] ?? ''));
    if (parents.length > 0 && !parents.some((parent) => file.parents.includes(parent))) return false;
    return true;
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';

    if (url.origin === brokerOrigin) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
      if (url.pathname === '/api/google/token') {
        calls.exchange += 1;
        const challenge = codes.get(body.code ?? '');
        if (!challenge || createHash('sha256').update(body.code_verifier ?? '', 'ascii').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
        codes.delete(body.code ?? '');
        const refresh = `1-test-${randomBytes(6).toString('hex')}`;
        refreshTokens.add(refresh);
        return json(200, { access_token: issueAccess(), expires_in: 3599, refresh_token: refresh, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
      }
      if (url.pathname === '/api/google/refresh') {
        calls.refresh += 1;
        if (!refreshTokens.has(body.refresh_token ?? '')) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(200, { access_token: issueAccess(), expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
      }
      return json(404, { error: 'not_found' });
    }

    if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) {
      calls.revoke += 1;
      const token = new URLSearchParams(String(init?.body ?? '')).get('token') ?? '';
      refreshTokens.delete(token);
      return new Response('', { status: 200 });
    }

    if (url.hostname !== 'www.googleapis.com') return json(404, {});
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    if (!accessTokens.has(authorization.replace(/^Bearer /u, ''))) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    const failure = failures.shift();
    if (failure) return json(failure.status, { error: { code: failure.status, errors: [{ reason: failure.reason }] } });

    if (url.pathname === '/drive/v3/about') {
      calls.about += 1;
      return json(200, { user: { emailAddress: email, displayName: 'Tester' }, storageQuota: { limit: '16106127360', usage: '1073741824' } });
    }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      calls.list += 1;
      const query = url.searchParams.get('q') ?? '';
      const found = [...files.values()].filter((file) => matches(file, query));
      if (url.searchParams.get('orderBy')?.startsWith('modifiedTime desc')) found.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
      const size = Number(url.searchParams.get('pageSize') ?? 100);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = found.slice(start, start + size);
      return json(200, { files: page.map(view), ...(start + size < found.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      calls.create += 1;
      const metadata = JSON.parse(String(init?.body ?? '{}')) as { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> };
      const file: FakeFile = { id: `f${randomBytes(6).toString('hex')}`, name: metadata.name, parents: metadata.parents ?? ['root'], mimeType: metadata.mimeType, content: Buffer.alloc(0), modifiedTime: tick(), appProperties: metadata.appProperties ?? {}, trashed: false };
      files.set(file.id, file);
      return json(200, view(file));
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      calls.create += 1;
      const boundary = /boundary=([^;]+)/u.exec(new Headers(init?.headers).get('content-type') ?? '')?.[1] ?? '';
      const raw = Buffer.from(init?.body as Uint8Array);
      const parts = splitMultipart(raw, boundary);
      const metadata = JSON.parse(parts[0]?.toString('utf8') ?? '{}') as { name: string; parents?: string[]; mimeType: string };
      const file: FakeFile = { id: `f${randomBytes(6).toString('hex')}`, name: metadata.name, parents: metadata.parents ?? ['root'], mimeType: metadata.mimeType, content: parts[1] ?? Buffer.alloc(0), modifiedTime: tick(), appProperties: {}, trashed: false };
      files.set(file.id, file);
      return json(200, view(file));
    }
    const media = /^\/upload\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (media && method === 'PATCH') {
      calls.update += 1;
      const file = files.get(decodeURIComponent(media[1] ?? ''));
      if (!file || file.trashed) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      file.content = Buffer.from(init?.body as Uint8Array);
      file.modifiedTime = tick();
      return json(200, view(file));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (one) {
      const file = files.get(decodeURIComponent(one[1] ?? ''));
      if (!file || file.trashed) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      if (method === 'DELETE') { calls.remove += 1; files.delete(file.id); return new Response(null, { status: 204 }); }
      if (url.searchParams.get('alt') === 'media') { calls.download += 1; return new Response(new Uint8Array(file.content), { status: 200 }); }
      return json(200, view(file));
    }
    return json(404, { error: { code: 404 } });
  }) as typeof fetch;

  return {
    fetchImpl,
    files,
    calls,
    email,
    issueCode: (challenge: string) => { const code = `4/code-${randomBytes(6).toString('hex')}`; codes.set(code, challenge); return code; },
    failNext: (status: number, count = 1, reason = 'rateLimitExceeded') => { for (let index = 0; index < count; index += 1) failures.push({ status, reason }); },
    expireAccessTokens: () => { accessTokens = new Set(); },
    revokeAll: () => { refreshTokens.clear(); accessTokens = new Set(); },
  };
}

function unescape(value: string): string {
  return value.replace(/\\(.)/gu, '$1');
}

function splitMultipart(raw: Buffer, boundary: string): Buffer[] {
  const marker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let index = raw.indexOf(marker);
  while (index !== -1) {
    const start = index + marker.length;
    const next = raw.indexOf(marker, start);
    if (next === -1) break;
    const chunk = raw.subarray(start, next);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) parts.push(chunk.subarray(headerEnd + 4, chunk.length - 2));
    index = next;
  }
  return parts;
}
