import { listChats, newReadStats, readMessages, type ChatFile, type ChatListing, type ChatMessage } from '../../../packages/chats/src/index.js';
import type { ChatSearchDone, ChatSearchEvent, ChatSearchHit, ChatSearchRequest, ChatSearchScope, ChatSearchWho } from '../../../packages/contracts/src/index.js';
import { runPooled } from '../../../packages/platform/src/index.js';

/**
 * Search every chat of a profile, by reading them.
 *
 * There is no index: on a host that keeps its files in memory an index costs
 * as much memory as it saves time, so the chats are read afresh for every
 * search, newest first, and hits are sent as they are found.
 *
 * Words match the way people type them: without accents, without case, with
 * `đ` as `d`, so "khong" finds "Không". A word matches where the text, read a
 * character at a time, has the word's letters in any accent or case, with
 * combining marks after a letter passed over. Every word must be in one
 * message; a quoted part must be there as written, spaces included.
 *
 * Most of a chat file is not what anybody reads - swipes, reasoning, the state
 * extensions keep - so a message's raw line is first looked over, undecoded,
 * for every word spelled in UTF-8 bytes. Only a line that has them all is
 * parsed. What is looked for is never written anywhere: no log, no telemetry.
 */

export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 1000;
export const MAX_QUERY_LENGTH = 500;
export const MAX_QUERY_TERMS = 16;
/** Chats read at once: reading is what takes the time, and one file at a time leaves the disk idle. */
const SCAN_CONCURRENCY = 4;
const PROGRESS_EVERY_MS = 250;
const SNIPPET_LENGTH = 160;
const SNIPPET_LEAD = 60;
const ELLIPSIS = '…';
/**
 * How much older than a date filter a chat file may look and still be read.
 * A message's date is never later than its file was written, but dates
 * written without a time zone are this machine's time.
 */
const MTIME_SLACK_MS = 2 * 24 * 60 * 60 * 1000;
const READ_BUFFER_BYTES = 256 * 1024;

export interface SearchTerm {
  /** As typed, quotes removed. */
  readonly text: string;
  /** With accents and case taken away; see `foldText`. */
  readonly folded: string;
}

export interface SearchOptions {
  readonly q: string;
  readonly character?: string | null;
  readonly group?: string | null;
  readonly from?: number | null;
  readonly to?: number | null;
  readonly who?: ChatSearchWho;
  readonly limit?: number;
}

/**
 * Split a query into words. A quoted part is one word, spaces and all; an
 * unclosed quote runs to the end. Duplicates go, and a word that is only
 * accents is no word.
 */
export function parseQuery(q: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const seen = new Set<string>();
  const pattern = /"([^"]*)"?|(\S+)/g;
  for (const match of q.slice(0, MAX_QUERY_LENGTH).matchAll(pattern)) {
    const text = (match[1] ?? match[2] ?? '').trim().replace(/\s+/g, ' ');
    const folded = foldText(text);
    if (!folded || seen.has(folded)) continue;
    seen.add(folded);
    terms.push({ text, folded });
    if (terms.length === MAX_QUERY_TERMS) break;
  }
  return terms;
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const foldCache = new Map<string, string>();

/**
 * One character with its accents and case taken away: `Ố` is `o`, `Đ` is
 * `d`, a combining mark is nothing. A character whose base is more than one
 * character (a few Indic and Hebrew presentation forms) stays as it is.
 */
export function foldChar(char: string): string {
  const code = char.charCodeAt(0);
  if (char.length === 1 && code < 0x80) return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : char;
  let folded = foldCache.get(char);
  if (folded === undefined) {
    folded = computeFold(char);
    foldCache.set(char, folded);
  }
  return folded;
}

function computeFold(char: string): string {
  if (char === 'đ' || char === 'Đ') return 'd';
  const strip = (text: string): string => text.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
  const folded = strip(strip(char).toLowerCase());
  return [...folded].length > 1 ? char : folded;
}

/** Text with accents and case taken away, and every run of spaces one space. */
export function foldText(text: string): string {
  let folded = '';
  let space = false;
  for (const char of text) {
    if (/\s/.test(char)) { space = folded.length > 0; continue; }
    const base = foldChar(char);
    if (!base) continue;
    if (space) { folded += ' '; space = false; }
    folded += base;
  }
  return folded;
}

let variantTable: Map<string, string[]> | null = null;

/**
 * Every character that folds to each base character, the base included.
 * Built once, on the first search, from the Basic Multilingual Plane.
 */
function variants(): Map<string, string[]> {
  if (variantTable) return variantTable;
  const table = new Map<string, string[]>();
  for (let code = 0; code < 0x10000; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCharCode(code);
    // Not through the cache: that would keep all 65,000 of them.
    const base = code < 0x80 ? foldChar(char) : computeFold(char);
    if (!base || base === char) continue;
    const list = table.get(base) ?? [base];
    list.push(char);
    table.set(base, list);
  }
  variantTable = table;
  return table;
}

function variantsOf(base: string): readonly string[] {
  return variants().get(base) ?? [base];
}

/** The Unicode spaces `\s` matches, for finding a phrase's space in raw bytes. */
const SPACE_CHARS = ['\u00a0', '\u1680', ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)), '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'];

export class TermMatcher {
  private readonly text: RegExp[];
  private readonly raw: RegExp[];

  public constructor(public readonly terms: readonly SearchTerm[]) {
    this.text = terms.map((term) => new RegExp(textPattern(term.folded), 'gu'));
    // The rarest-looking word first: a longer one turns more lines down.
    this.raw = [...terms].sort((left, right) => right.folded.length - left.folded.length).map((term) => new RegExp(rawPattern(term.folded)));
  }

  /**
   * Whether a message's raw line could hold every word, looking only at the
   * bytes of what is read: `mes` and `extra.display_text`.
   *
   * Those are found by their keys as `JSON.stringify` writes them. Inside a
   * JSON string a quote is always escaped, so `"mes":"` in the bytes is a key;
   * when it is there more than once, or not at all - another program wrote the
   * file, or an extension keeps its own `mes` - the whole line is looked at.
   */
  public couldMatch(line: Buffer): boolean {
    const written = valueBytes(line, MES_KEY);
    if (!written) return this.couldMatchBytes(line);
    if (this.couldMatchBytes(written)) return true;
    const shown = valueBytes(line, DISPLAY_TEXT_KEY);
    if (shown === undefined) return this.couldMatchBytes(line);
    return shown !== null && this.couldMatchBytes(shown);
  }

  /**
   * Whether raw bytes, read as Latin-1 so each byte is one character, could
   * hold every word. Bytes with a `\u` escape in them always could: their
   * letters are not where the bytes say.
   */
  private couldMatchBytes(bytes: Buffer): boolean {
    if (bytes.includes(UNICODE_ESCAPE)) return true;
    const text = bytes.toString('latin1');
    for (const pattern of this.raw) if (!pattern.test(text)) return false;
    return true;
  }

  /** Where every word is in `text`, merged and in order; null unless all of them are there. */
  public match(text: string): Array<[number, number]> | null {
    const ranges: Array<[number, number]> = [];
    for (const pattern of this.text) {
      pattern.lastIndex = 0;
      let found = false;
      for (const match of text.matchAll(pattern)) {
        if (match[0].length === 0) continue;
        found = true;
        ranges.push([match.index, match.index + match[0].length]);
      }
      if (!found) return null;
    }
    return mergeRanges(ranges);
  }
}

const MES_KEY = Buffer.from('"mes":"');
const DISPLAY_TEXT_KEY = Buffer.from('"display_text":"');
const UNICODE_ESCAPE = Buffer.from('\\u');
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * The bytes of the one string value under `key` in a raw line; null when the
 * key is not there, undefined when it is there more than once or its string
 * does not end.
 */
function valueBytes(line: Buffer, key: Buffer): Buffer | null | undefined {
  const at = line.indexOf(key);
  if (at === -1) return null;
  const start = at + key.length;
  let end = start;
  for (;;) {
    end = line.indexOf(QUOTE, end);
    if (end === -1) return undefined;
    let backslashes = 0;
    while (end - 1 - backslashes >= start && line[end - 1 - backslashes] === BACKSLASH) backslashes += 1;
    if (backslashes % 2 === 0) break;
    end += 1;
  }
  // A second key can only be after the value: it cannot be inside a string.
  return line.indexOf(key, end + 1) === -1 ? line.subarray(start, end) : undefined;
}

function textPattern(folded: string): string {
  let pattern = '';
  for (const char of folded) {
    if (char === ' ') { pattern += '\\s+'; continue; }
    pattern += `[${variantsOf(char).map(escapeClassChar).join('')}][\\u0300-\\u036f]*`;
  }
  return pattern;
}

function escapeClassChar(char: string): string {
  return /[\\\]^[-]/.test(char) ? `\\${char}` : char;
}

/**
 * The same word as `textPattern`, spelled as the bytes it takes in a chat
 * file's JSON: UTF-8, with `"` and `\` escaped, and a space as any space or
 * an escaped line break.
 */
function rawPattern(folded: string): string {
  const marks = '(?:\\xcc[\\x80-\\xbf]|\\xcd[\\x80-\\xaf])*';
  const space = `(?:[ \\t\\r\\n]|\\\\[nrtf]|${SPACE_CHARS.map(rawBytes).join('|')})+`;
  let pattern = '';
  for (const char of folded) {
    if (char === ' ') { pattern += space; continue; }
    pattern += `(?:${variantsOf(char).map(rawBytes).join('|')})${marks}`;
  }
  return pattern;
}

function rawBytes(char: string): string {
  const json = char === '"' || char === '\\' ? `\\${char}` : char;
  let pattern = '';
  for (const byte of Buffer.from(json, 'utf8')) {
    pattern += (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return pattern;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * About `SNIPPET_LENGTH` characters of `text` around the first match, line
 * breaks as spaces, with an ellipsis where it was cut, and the matches in it.
 */
export function snippetOf(text: string, ranges: ReadonlyArray<readonly [number, number]>): { snippet: string; ranges: Array<[number, number]> } {
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, first - SNIPPET_LEAD);
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  start = Math.max(0, Math.min(start, end - SNIPPET_LENGTH));
  // Never half a surrogate pair at either end.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end += 1;
  const lead = start > 0 ? ELLIPSIS : '';
  const snippet = lead + text.slice(start, end).replace(/\s/g, ' ') + (end < text.length ? ELLIPSIS : '');
  const shifted: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    const clippedFrom = Math.max(from, start);
    const clippedTo = Math.min(to, end);
    if (clippedFrom < clippedTo) shifted.push([clippedFrom - start + lead.length, clippedTo - start + lead.length]);
  }
  return { snippet, ranges: shifted };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** What can be searched: the characters and groups that have chats. */
export function searchScope(listing: ChatListing): ChatSearchScope {
  const characters = new Map<string, { id: string; chats: number; modified: number }>();
  const groupChats = new Map<string, { chats: number; modified: number }>();
  let totalBytes = 0;
  for (const chat of listing.chats) {
    totalBytes += chat.size;
    if (chat.character !== null) {
      const entry = characters.get(chat.character) ?? { id: chat.character, chats: 0, modified: 0 };
      entry.chats += 1;
      entry.modified = Math.max(entry.modified, chat.modified);
      characters.set(chat.character, entry);
    } else if (chat.groupId !== null) {
      const entry = groupChats.get(chat.groupId) ?? { chats: 0, modified: 0 };
      entry.chats += 1;
      entry.modified = Math.max(entry.modified, chat.modified);
      groupChats.set(chat.groupId, entry);
    }
  }
  return {
    characters: [...characters.values()].sort((left, right) => left.id.localeCompare(right.id)),
    groups: listing.groups.filter((group) => groupChats.has(group.id)).map((group) => ({ id: group.id, name: group.name, ...groupChats.get(group.id)! })),
    totalChats: listing.chats.length,
    totalBytes,
  };
}

/**
 * Search a user directory's chats, newest chat first, sending each hit as it
 * is found and a progress line now and then.
 *
 * Chats are read a few at a time, and hits still come out newest chat first:
 * a chat's hits wait until every newer chat has been sent. Once the limit is
 * reached no further chat is started. Stops early, with what it has, when
 * `signal` is aborted.
 */
export async function searchChats(userRoot: string, options: SearchOptions, deps: { readonly signal: AbortSignal; readonly emit: (event: ChatSearchEvent) => void | Promise<void>; readonly now?: () => number; readonly listing?: ChatListing }): Promise<ChatSearchDone> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const terms = parseQuery(options.q);
  const matcher = new TermMatcher(terms);
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT)));
  const from = options.from ?? null;
  const to = options.to ?? null;
  const who = options.who ?? 'any';
  const listing = deps.listing ?? await listChats(userRoot);
  const groupNames = new Map(listing.groups.map((group) => [group.id, group.name]));
  const chats = listing.chats.filter((chat) => {
    if (options.character && chat.character !== options.character) return false;
    if (options.group && chat.groupId !== options.group) return false;
    return !(from !== null && chat.modified + MTIME_SLACK_MS < from);
  });
  const totals = { scannedChats: 0, scannedBytes: 0, malformedLines: 0, oversizedLines: 0, found: 0 };
  const results = new Map<number, ChatSearchHit[]>();
  let next = 0;
  let sent = 0;
  let stoppedEarly = false;
  let lastProgress = startedAt;
  const buffers: Buffer[] = [];
  const flush = async (): Promise<void> => {
    while (results.has(next)) {
      const hits = results.get(next)!;
      results.delete(next);
      next += 1;
      for (const hit of hits) {
        if (sent >= limit || deps.signal.aborted) { stoppedEarly = true; break; }
        sent += 1;
        await deps.emit(hit);
      }
    }
    if (now() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = now();
      await deps.emit({ type: 'progress', scannedChats: totals.scannedChats, totalChats: chats.length });
    }
  };
  await deps.emit({ type: 'progress', scannedChats: 0, totalChats: chats.length });
  if (terms.length > 0) {
    // Emission is serialised: hits from chats read at once must not interleave.
    let emitting = Promise.resolve();
    await runPooled(chats.map((chat, order) => ({ chat, order })), SCAN_CONCURRENCY, async ({ chat, order }, slot) => {
      if (deps.signal.aborted || totals.found >= limit) { stoppedEarly = true; results.set(order, []); emitting = emitting.then(flush); return; }
      const buffer = buffers[slot] ??= Buffer.allocUnsafe(READ_BUFFER_BYTES);
      const hits = await searchChat(chat, { matcher, from, to, who, limit, groupName: chat.groupId ? groupNames.get(chat.groupId) ?? null : null, signal: deps.signal, buffer, totals });
      totals.found += hits.length;
      results.set(order, hits);
      emitting = emitting.then(flush);
      await emitting;
    });
    await emitting;
  }
  const done: ChatSearchDone = {
    type: 'done',
    scannedChats: totals.scannedChats,
    totalChats: chats.length,
    scannedBytes: totals.scannedBytes,
    hits: sent,
    ms: Math.round(now() - startedAt),
    truncated: stoppedEarly || deps.signal.aborted || totals.found > sent,
    malformedLines: totals.malformedLines,
    oversizedLines: totals.oversizedLines,
  };
  await deps.emit(done);
  return done;
}

async function searchChat(chat: ChatFile, context: {
  readonly matcher: TermMatcher;
  readonly from: number | null;
  readonly to: number | null;
  readonly who: ChatSearchWho;
  readonly limit: number;
  readonly groupName: string | null;
  readonly signal: AbortSignal;
  readonly buffer: Buffer;
  readonly totals: { scannedChats: number; scannedBytes: number; malformedLines: number; oversizedLines: number };
}): Promise<ChatSearchHit[]> {
  const { matcher, from, to, who, limit, signal, totals } = context;
  const stats = newReadStats();
  const hits: ChatSearchHit[] = [];
  try {
    for await (const message of readMessages(chat, { signal, stats, buffer: context.buffer, prefilter: (raw) => matcher.couldMatch(raw) })) {
      if (!wanted(message, who, from, to)) continue;
      const found = matchMessage(matcher, message);
      if (!found) continue;
      hits.push({
        type: 'hit',
        kind: chat.kind,
        chat: chat.name,
        character: chat.character,
        characterName: stats.header?.characterName ?? null,
        group: chat.groupId ? { id: chat.groupId, name: context.groupName ?? chat.groupId } : null,
        chatModified: chat.modified,
        index: message.index,
        date: message.sendDate,
        name: message.name,
        isUser: message.isUser,
        ...found,
      });
      if (hits.length >= limit) break;
    }
  } catch {
    // A chat that went away or cannot be read is passed over, like one with no hits.
  }
  if (!signal.aborted) totals.scannedChats += 1;
  totals.scannedBytes += stats.bytes;
  totals.malformedLines += stats.malformed;
  totals.oversizedLines += stats.oversized;
  return hits;
}

function wanted(message: ChatMessage, who: ChatSearchWho, from: number | null, to: number | null): boolean {
  if (who === 'me' && !message.isUser) return false;
  if (who === 'them' && message.isUser) return false;
  if (from === null && to === null) return true;
  if (message.sendDate === null) return false;
  return (from === null || message.sendDate >= from) && (to === null || message.sendDate < to);
}

/** The words in what SillyTavern shows for a message, else in what was written. */
function matchMessage(matcher: TermMatcher, message: ChatMessage): { snippet: string; ranges: Array<[number, number]> } | null {
  for (const text of message.shownText ? [message.shownText, message.text] : [message.text]) {
    const ranges = matcher.match(text);
    if (ranges) return snippetOf(text, ranges);
  }
  return null;
}

/**
 * The search running now. One at a time per manager: a new search from the
 * same session stops its last one, which a typist does with every key; one
 * from another session waits its turn.
 */
export class ChatSearches {
  private current: { readonly owner: string; readonly controller: AbortController } | null = null;

  /** A signal for a new search, or null while somebody else's is running. */
  public begin(owner: string): AbortController | null {
    if (this.current && this.current.owner !== owner) return null;
    this.current?.controller.abort();
    const controller = new AbortController();
    this.current = { owner, controller };
    return controller;
  }

  public end(controller: AbortController): void {
    if (this.current?.controller === controller) this.current = null;
  }

  public close(): void {
    this.current?.controller.abort();
    this.current = null;
  }
}

/** A request body as a search, or a reason it is not one. */
export function parseSearchRequest(body: unknown): { request: ChatSearchRequest } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'The body must be an object' };
  const value = body as Record<string, unknown>;
  if (typeof value.q !== 'string' || value.q.length > MAX_QUERY_LENGTH) return { error: `q must be text of at most ${MAX_QUERY_LENGTH} characters` };
  if (parseQuery(value.q).length === 0) return { error: 'q must have a word in it' };
  const optionalText = (field: unknown): field is string | undefined | null => field === undefined || field === null || (typeof field === 'string' && field.length <= 1024);
  const optionalTime = (field: unknown): field is number | undefined | null => field === undefined || field === null || (typeof field === 'number' && Number.isFinite(field));
  if (!optionalText(value.character) || !optionalText(value.group)) return { error: 'character and group must be text' };
  if (!optionalTime(value.from) || !optionalTime(value.to)) return { error: 'from and to must be times in milliseconds' };
  if (value.who !== undefined && value.who !== 'any' && value.who !== 'me' && value.who !== 'them') return { error: 'who must be any, me or them' };
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_SEARCH_LIMIT)) return { error: `limit must be a whole number from 1 to ${MAX_SEARCH_LIMIT}` };
  return {
    request: {
      q: value.q,
      ...(value.character ? { character: value.character } : {}),
      ...(value.group ? { group: value.group } : {}),
      ...(typeof value.from === 'number' ? { from: value.from } : {}),
      ...(typeof value.to === 'number' ? { to: value.to } : {}),
      ...(value.who ? { who: value.who } : {}),
      ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
    },
  };
}
