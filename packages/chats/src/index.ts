import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatKind } from '../../contracts/src/index.js';
import { ioConcurrency, runPooled } from '../../platform/src/index.js';

/**
 * SillyTavern's chats, read off the disk.
 *
 * A profile's user directory keeps them in two places:
 *
 * - `chats/<card name>/<chat name>.jsonl`, one folder per character, named
 *   after its card's file without `.png`;
 * - `group chats/<chat id>.jsonl`, with each group in `groups/<id>.json`
 *   naming its chats.
 *
 * A chat is one JSON value per line. SillyTavern reads it by splitting on line
 * breaks and dropping every line that is not JSON; of what is left, the first
 * line of a character chat is always the header (`user_name`,
 * `character_name`, `create_date`, `chat_metadata`), and the first line of a
 * group chat is the header only when it has `chat_metadata`, because old group
 * chats have none. Everything after it is a message, and its place among them
 * is the `mesid` SillyTavern shows it under.
 *
 * Nothing here writes, and nothing holds a whole chat: a chat is read a chunk
 * at a time, and a line longer than `MAX_LINE_BYTES` - a picture kept in the
 * chat as base64 - is passed over without being kept.
 */

export const CHATS_DIR = 'chats';
export const GROUP_CHATS_DIR = 'group chats';
export const GROUPS_DIR = 'groups';
export const CHAT_EXTENSION = '.jsonl';
/** The longest line that is read; a longer one is counted and skipped. */
export const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

export interface ChatFile {
  readonly kind: ChatKind;
  /** The chat's name, which is its file name without `.jsonl`. */
  readonly name: string;
  /** For a character chat, its folder: the card's file name without `.png`. */
  readonly character: string | null;
  /** For a group chat, the group that names it, when one still does. */
  readonly groupId: string | null;
  readonly path: string;
  readonly size: number;
  /** When the file was last written, in milliseconds. */
  readonly modified: number;
}

export interface ChatGroup {
  readonly id: string;
  readonly name: string;
  /** The members' card files. */
  readonly members: readonly string[];
  readonly chats: readonly string[];
}

export interface ChatListing {
  /** Newest first. */
  readonly chats: readonly ChatFile[];
  readonly groups: readonly ChatGroup[];
}

export interface ChatHeader {
  readonly userName: string | null;
  readonly characterName: string | null;
  readonly createDate: number | null;
}

export interface ChatMessage {
  /** Its place in the chat, which is SillyTavern's `mesid`. */
  readonly index: number;
  readonly name: string;
  readonly isUser: boolean;
  readonly isSystem: boolean;
  /** When it was sent, in milliseconds, or null; see `parseSendDate`. */
  readonly sendDate: number | null;
  /** The message as written: `mes`. */
  readonly text: string;
  /** What SillyTavern shows instead, when a translation put one there: `extra.display_text`. */
  readonly shownText: string | null;
}

/** What reading one chat came across, filled in while it is read. */
export interface ChatReadStats {
  bytes: number;
  /** Messages, the ones passed over included. */
  messages: number;
  /** Lines that were not JSON. */
  malformed: number;
  /** Lines longer than `MAX_LINE_BYTES`. */
  oversized: number;
  header: ChatHeader | null;
}

export function newReadStats(): ChatReadStats {
  return { bytes: 0, messages: 0, malformed: 0, oversized: 0, header: null };
}

export interface ReadMessagesOptions {
  readonly signal?: AbortSignal;
  readonly stats?: ChatReadStats;
  /**
   * A quick look at a message's raw bytes before they are decoded and parsed;
   * the buffer is only valid during the call. A line it turns down is counted
   * as a message and not parsed, unless it is not even shaped like an object.
   * A line that is shaped like one and still is not JSON is only found by
   * parsing, so if it is turned down, the messages after it are numbered one
   * higher than SillyTavern numbers them; such lines are rare enough for that
   * to be the price of the speed.
   */
  readonly prefilter?: (line: Buffer) => boolean;
  /** A buffer to read into, so a caller reading many chats in turn can reuse one. */
  readonly buffer?: Buffer;
}

/** Every chat in a user directory, newest first. A folder or file that cannot be read is left out. */
export async function listChats(userRoot: string, options: { readonly concurrency?: number } = {}): Promise<ChatListing> {
  const concurrency = options.concurrency ?? ioConcurrency();
  const groups = await readGroups(join(userRoot, GROUPS_DIR), concurrency);
  const groupOfChat = new Map<string, string>();
  for (const group of groups) for (const chat of group.chats) if (!groupOfChat.has(chat)) groupOfChat.set(chat, group.id);
  const candidates: Array<Omit<ChatFile, 'size' | 'modified'>> = [];
  const chatsRoot = join(userRoot, CHATS_DIR);
  for (const folder of await directories(chatsRoot)) {
    for (const file of await chatFileNames(join(chatsRoot, folder))) {
      candidates.push({ kind: 'character', name: file.slice(0, -CHAT_EXTENSION.length), character: folder, groupId: null, path: join(chatsRoot, folder, file) });
    }
  }
  const groupChatsRoot = join(userRoot, GROUP_CHATS_DIR);
  for (const file of await chatFileNames(groupChatsRoot)) {
    const name = file.slice(0, -CHAT_EXTENSION.length);
    candidates.push({ kind: 'group', name, character: null, groupId: groupOfChat.get(name) ?? null, path: join(groupChatsRoot, file) });
  }
  const chats: ChatFile[] = [];
  await runPooled(candidates, concurrency, async (candidate) => {
    const info = await stat(candidate.path).catch(() => null);
    if (info?.isFile()) chats.push({ ...candidate, size: info.size, modified: info.mtimeMs });
  });
  chats.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
  return { chats, groups };
}

async function directories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function chatFileNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(CHAT_EXTENSION) && entry.name.length > CHAT_EXTENSION.length).map((entry) => entry.name).sort();
}

async function readGroups(root: string, concurrency: number): Promise<ChatGroup[]> {
  const files = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'));
  const groups: ChatGroup[] = [];
  await runPooled(files, concurrency, async (entry) => {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(root, entry.name), 'utf8')); } catch { return; }
    if (!isRecord(value)) return;
    const id = typeof value.id === 'string' && value.id ? value.id : entry.name.slice(0, -'.json'.length);
    const chats = strings(value.chats);
    // `chat_id` is the chat open now, which an old group lists nowhere else.
    if (typeof value.chat_id === 'string' && value.chat_id && !chats.includes(value.chat_id)) chats.push(value.chat_id);
    groups.push({ id, name: typeof value.name === 'string' && value.name ? value.name : id, members: strings(value.members), chats });
  });
  return groups.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/**
 * The messages of one chat, in order.
 *
 * Stops quietly when `signal` is aborted. A file that cannot be opened ends
 * it with the error.
 */
export async function* readMessages(chat: Pick<ChatFile, 'kind' | 'path'>, options: ReadMessagesOptions = {}): AsyncGenerator<ChatMessage> {
  const { signal, prefilter } = options;
  const stats = options.stats ?? newReadStats();
  const buffer = options.buffer ?? Buffer.allocUnsafe(READ_CHUNK_BYTES);
  // Lines are counted the way SillyTavern counts them: only the ones that are JSON.
  let headerPending = true;
  const handle = await open(chat.path, 'r');
  try {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let discarding = false;
    const take = (line: Buffer): ChatMessage | null => {
      const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
      if (isBlank(line, 0, end)) return null;
      if (headerPending) {
        // A header carries the whole `chat_metadata`, which can be large, and
        // only its first fields are wanted: read them off the front.
        const header = chat.kind === 'character' ? quickHeader(line, end) : null;
        if (header) {
          headerPending = false;
          stats.header = header;
          return null;
        }
      }
      // The header is parsed whatever the prefilter says: it decides what follows.
      if (!headerPending && prefilter && !prefilter(line.subarray(0, end)) && looksLikeObject(line, end)) {
        stats.messages += 1;
        return null;
      }
      let value: unknown;
      try { value = JSON.parse(line.toString('utf8', 0, end)); } catch { stats.malformed += 1; return null; }
      if (!value) return null;
      if (headerPending) {
        headerPending = false;
        if (chat.kind === 'character' || (isRecord(value) && Object.hasOwn(value, 'chat_metadata'))) {
          stats.header = isRecord(value) ? chatHeader(value, chat.kind) : null;
          return null;
        }
      }
      stats.messages += 1;
      return isRecord(value) ? chatMessage(value, stats.messages - 1) : null;
    };
    const oversized = (): void => {
      // Counted as the message it almost certainly is, so the ones after it keep their numbers.
      stats.oversized += 1;
      if (headerPending) { headerPending = false; if (chat.kind === 'character') return; }
      stats.messages += 1;
    };
    for (;;) {
      if (signal?.aborted) return;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      stats.bytes += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(NEWLINE, start);
        const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        if (discarding) {
          if (end < bytesRead) { discarding = false; oversized(); }
        } else if (end === bytesRead) {
          // The line goes on in the next chunk.
          pendingBytes += end - start;
          if (pendingBytes > MAX_LINE_BYTES) { discarding = true; pending = []; pendingBytes = 0; } else pending.push(Buffer.from(buffer.subarray(start, end)));
        } else if (pendingBytes + end - start > MAX_LINE_BYTES) {
          pending = []; pendingBytes = 0; oversized();
        } else {
          const line = pending.length > 0 ? Buffer.concat([...pending, buffer.subarray(start, end)]) : buffer.subarray(start, end);
          pending = []; pendingBytes = 0;
          const message = take(line);
          if (message) yield message;
          if (signal?.aborted) return;
        }
        start = end + 1;
      }
    }
    if (discarding) oversized();
    else if (pending.length > 0) {
      const message = take(Buffer.concat(pending));
      if (message) yield message;
    }
  } finally {
    await handle.close();
  }
}


/**
 * Whether a line is shaped like a JSON object: `{` first and `}` last. A line
 * cut short by a write that never finished is not, and is parsed rather than
 * counted unseen, so it is dropped the way SillyTavern drops it.
 */
function looksLikeObject(line: Buffer, end: number): boolean {
  let first = 0;
  while (first < end && isSpace(line[first]!)) first += 1;
  let last = end - 1;
  while (last > first && isSpace(line[last]!)) last -= 1;
  return line[first] === 0x7b && line[last] === 0x7d;
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function isBlank(buffer: Buffer, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a) return false;
  }
  return true;
}

/** How far into a header line its first fields are looked for. */
const HEADER_PEEK_BYTES = 4096;
const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
/** A header as SillyTavern writes it: `user_name`, `character_name` and `create_date`, in that order, first. */
const HEADER_FRONT = new RegExp(`^\\{\\s*"user_name"\\s*:\\s*(${JSON_STRING})\\s*,\\s*"character_name"\\s*:\\s*(${JSON_STRING})(?:\\s*,\\s*"create_date"\\s*:\\s*(${JSON_STRING}|\\d+))?`);

/** The header's first fields read off the front of its line, or null when it does not start the way SillyTavern writes one. */
function quickHeader(line: Buffer, end: number): ChatHeader | null {
  const match = HEADER_FRONT.exec(line.toString('utf8', 0, Math.min(end, HEADER_PEEK_BYTES)));
  if (!match) return null;
  try {
    return chatHeader({ user_name: JSON.parse(match[1]!), character_name: JSON.parse(match[2]!), create_date: match[3] === undefined ? null : JSON.parse(match[3]) }, 'character');
  } catch {
    return null;
  }
}

function chatHeader(value: Record<string, unknown>, kind: ChatKind): ChatHeader {
  // A group chat's header names nobody: SillyTavern writes 'unused' there.
  const name = (field: unknown): string | null => typeof field === 'string' && field && !(kind === 'group' && field === 'unused') ? field : null;
  return { userName: name(value.user_name), characterName: name(value.character_name), createDate: parseSendDate(value.create_date) };
}

function chatMessage(value: Record<string, unknown>, index: number): ChatMessage {
  const extra = isRecord(value.extra) ? value.extra : null;
  return {
    index,
    name: typeof value.name === 'string' ? value.name : '',
    isUser: value.is_user === true,
    isSystem: value.is_system === true,
    sendDate: parseSendDate(value.send_date),
    text: typeof value.mes === 'string' ? value.mes : '',
    shownText: extra && typeof extra.display_text === 'string' && extra.display_text ? extra.display_text : null,
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const MERIDIEM_DATE = /([A-Za-z]+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i;
const HUMANIZED_DATES = [
  /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms/,
  /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/,
  /(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/,
];

/**
 * A message's `send_date` in milliseconds, or null when it cannot be read.
 *
 * SillyTavern has written it several ways over the years, and reads them back
 * the same way this does (`timestampToMoment` in its `utils.js`):
 *
 * - milliseconds, as a number or a string of digits;
 * - ISO 8601, which current versions write;
 * - `June 3, 2024 5:05pm`, without a time zone, read as this machine's time;
 * - `2024-07-12@01h31m37s123ms` and two older spellings of it, which
 *   SillyTavern reads as UTC although they were written in local time.
 *
 * Anything else is null rather than a guess.
 */
export function parseSendDate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return valid(Number(text));
  if (ISO_DATE.test(text)) return valid(Date.parse(text.length === 10 ? `${text}T00:00` : text.replace(' ', 'T')));
  const meridiem = MERIDIEM_DATE.exec(text);
  if (meridiem) {
    const [, monthName = '', day = '', year = '', hour = '', minute = '', half = ''] = meridiem;
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month === -1 || (monthName.length > 3 && !FULL_MONTHS[month]?.startsWith(monthName.toLowerCase()))) return null;
    if (Number(minute) > 59) return null;
    const hour24 = (Number(hour) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
    return validParts(new Date(Number(year), month, Number(day), hour24, Number(minute)), Number(year), month, Number(day));
  }
  for (const pattern of HUMANIZED_DATES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const [, year = '', month = '', day = '', hour = '', minute = '', second = '', millisecond = '0'] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, '0'))));
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    return date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) ? valid(date.getTime()) : null;
  }
  return null;
}

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function valid(ms: number): number | null {
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A local date, unless its day or month rolled over: `February 30` is not March 2. */
function validParts(date: Date, year: number, month: number, day: number): number | null {
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? valid(date.getTime()) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}
