import type { ChatSearchEvent, ChatSearchHit, ChatSearchRequest } from '../../../packages/contracts/src/index.js';
import { apiFetch } from './session.js';

/**
 * The console's side of the chat search: the request, the stream of answers
 * read a line at a time, and what the page does with them.
 */

/** Lines of newline-delimited JSON out of text that arrives in pieces. */
export class LineSplitter {
  private rest = '';

  /** Every line the text completes; the unfinished one waits for the next piece. */
  public push(text: string): string[] {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  /** Whatever was left when the stream ended. */
  public end(): string[] {
    const rest = this.rest;
    this.rest = '';
    return rest.trim().length > 0 ? [rest] : [];
  }
}

export type SearchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly payload: unknown };

/**
 * Ask for a search and hand over each line of the answer as it comes. Events
 * that arrive together are handed over together, so the page renders once
 * for them. Ends when the stream does or `signal` is aborted.
 */
export async function streamSearch(request: ChatSearchRequest, options: { readonly csrfToken: string; readonly signal: AbortSignal; readonly onEvents: (events: ChatSearchEvent[]) => void }): Promise<SearchOutcome> {
  const response = await apiFetch('/api/v1/chats/search', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': options.csrfToken },
    body: JSON.stringify(request),
    signal: options.signal,
  });
  if (!response.ok || !response.body) return { ok: false, status: response.status, payload: await response.json().catch(() => null) };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const splitter = new LineSplitter();
  const parse = (lines: string[]): ChatSearchEvent[] => lines.flatMap((line) => {
    try { return [JSON.parse(line) as ChatSearchEvent]; } catch { return []; }
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parse(splitter.push(decoder.decode(value, { stream: true })));
      if (events.length > 0) options.onEvents(events);
    }
    const events = parse([...splitter.push(decoder.decode()), ...splitter.end()]);
    if (events.length > 0) options.onEvents(events);
  } finally {
    reader.releaseLock();
  }
  return { ok: true };
}

/** A snippet cut into the parts between matches and the matches themselves. */
export function highlightParts(snippet: string, ranges: ReadonlyArray<readonly [number, number]>): Array<{ readonly text: string; readonly match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  let at = 0;
  for (const [from, to] of [...ranges].sort((left, right) => left[0] - right[0])) {
    const start = Math.max(at, Math.min(from, snippet.length));
    const end = Math.max(start, Math.min(to, snippet.length));
    if (start > at) parts.push({ text: snippet.slice(at, start), match: false });
    if (end > start) parts.push({ text: snippet.slice(start, end), match: true });
    at = end;
  }
  if (at < snippet.length) parts.push({ text: snippet.slice(at), match: false });
  return parts;
}

/** The hits of one chat, in the order they were found. */
export interface ChatHitGroup {
  readonly key: string;
  readonly hits: readonly ChatSearchHit[];
}

export function chatKey(hit: Pick<ChatSearchHit, 'kind' | 'character' | 'group' | 'chat'>): string {
  return `${hit.kind}\u0000${hit.kind === 'group' ? hit.group?.id ?? '' : hit.character ?? ''}\u0000${hit.chat}`;
}

/** Hits added to their chats, a new chat after the ones already there. */
export function groupHits(groups: readonly ChatHitGroup[], hits: readonly ChatSearchHit[]): ChatHitGroup[] {
  const next = [...groups];
  const index = new Map(next.map((group, position) => [group.key, position]));
  for (const hit of hits) {
    const key = chatKey(hit);
    const position = index.get(key);
    if (position === undefined) {
      index.set(key, next.length);
      next.push({ key, hits: [hit] });
    } else {
      next[position] = { key, hits: [...next[position]!.hits, hit] };
    }
  }
  return next;
}

/** A day picked in a date field, `YYYY-MM-DD`, as the moment it starts here; null for none. */
export function dayStart(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** The moment after a picked day ends here, so the day itself is included; null for none. */
export function dayEnd(value: string): number | null {
  const start = dayStart(value);
  if (start === null) return null;
  const date = new Date(start);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}
