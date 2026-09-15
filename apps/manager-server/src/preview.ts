import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/**
 * The few facts behind the console's picture of SillyTavern.
 *
 * The overview shows a still of what SillyTavern looks like, and a generic
 * drawing of somebody else's install is a worse answer than the reader's own
 * wallpaper, their own theme colours and the characters they were last
 * talking to. Nothing here renders anything: it reads those few facts and the
 * console draws the shapes of the interface from them.
 *
 * What it deliberately does not read is any chat. The rows say which
 * characters are recent and when; the message bodies in the still are blank
 * bars. A picture on a dashboard is not worth opening somebody's conversations
 * to draw, and a blurred thumbnail could not show them legibly anyway.
 *
 * Two rules keep this from becoming a file server. Only the directories named
 * below are ever read, and only by a bare file name - a name carrying a
 * separator, a drive or a `..` is refused rather than resolved, so there is no
 * path for a request to climb out of them.
 */

/** What a browser will actually draw, by the extension on the file. */
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
]);

/** How many rows SillyTavern's own Recent Chats list shows. */
const RECENT_COUNT = 3;
/** Large enough for any character card; small enough that a mistake is cheap. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type PreviewKind = 'background' | 'avatar';

/**
 * The parts of the reader's theme the still needs.
 *
 * SillyTavern keeps these as CSS colour strings, and they are passed through
 * as it wrote them rather than parsed - the console only ever puts them back
 * into CSS, so anything it accepts is already the right shape.
 */
export interface PreviewTheme {
  readonly name: string | null;
  readonly text: string | null;
  readonly italics: string | null;
  readonly quote: string | null;
  readonly tint: string | null;
  readonly userTint: string | null;
  readonly botTint: string | null;
  readonly border: string | null;
  /** Percentage of the window the chat column takes, as SillyTavern stores it. */
  readonly chatWidth: number | null;
  readonly blur: number | null;
}

export interface PreviewChat {
  readonly name: string;
  /** The character card to draw beside the row, when there is one. */
  readonly avatar: string | null;
  readonly at: string;
}

export interface PreviewManifest {
  /** The background SillyTavern is set to, or null when there is none to show. */
  readonly background: string | null;
  readonly theme: PreviewTheme | null;
  readonly recent: readonly PreviewChat[];
}

export interface PreviewImage {
  readonly bytes: Buffer;
  readonly contentType: string;
}

const DIRECTORY: Record<PreviewKind, string> = { background: 'backgrounds', avatar: 'characters' };

/**
 * Whether a name is one file inside one directory, and nothing else.
 *
 * `basename` is not enough on its own: it would quietly turn `../../secrets`
 * into `secrets` and serve it. The name has to already be its own basename,
 * which means it contained no separator to strip.
 */
export function isPlainFileName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  // A Windows drive or stream qualifier is a path, whatever it looks like.
  if (name.includes(':')) return false;
  return basename(name) === name;
}

export function imageTypeFor(name: string): string | null {
  return IMAGE_TYPES.get(extname(name).toLowerCase()) ?? null;
}

function colour(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  // Long enough to be a colour and short enough not to be anything else.
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

function count(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** SillyTavern's own settings, or null when there are none to read yet. */
async function readSettings(userRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(userRoot, 'settings.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function themeOf(settings: Record<string, unknown> | null): PreviewTheme | null {
  const power = settings?.power_user;
  if (typeof power !== 'object' || power === null) return null;
  const source = power as Record<string, unknown>;
  return {
    name: colour(source, 'theme'),
    text: colour(source, 'main_text_color'),
    italics: colour(source, 'italics_text_color'),
    quote: colour(source, 'quote_text_color'),
    tint: colour(source, 'blur_tint_color'),
    userTint: colour(source, 'user_mes_blur_tint_color'),
    botTint: colour(source, 'bot_mes_blur_tint_color'),
    border: colour(source, 'border_color'),
    chatWidth: count(source, 'chat_width'),
    blur: count(source, 'blur_strength'),
  };
}

/** The background named in SillyTavern's own settings, if it names a usable one. */
function chosenBackground(settings: Record<string, unknown> | null): string | null {
  const background = settings?.background;
  if (typeof background !== 'object' || background === null) return null;
  const name = (background as { name?: unknown }).name;
  if (typeof name !== 'string' || !isPlainFileName(name) || !imageTypeFor(name)) return null;
  return name;
}

/** Image files in one of the two directories, newest first. */
async function newestImages(directory: string, limit: number): Promise<string[]> {
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const usable = names.filter((name) => isPlainFileName(name) && imageTypeFor(name) !== null);
  const dated = await Promise.all(usable.map(async (name) => {
    try { return { name, at: (await stat(join(directory, name))).mtimeMs }; }
    catch { return { name, at: 0 }; }
  }));
  dated.sort((left, right) => right.at - left.at);
  return dated.slice(0, limit).map((entry) => entry.name);
}

/**
 * The characters last talked to, newest first.
 *
 * SillyTavern files a conversation under a directory named for the character,
 * so the directory's newest chat file is when that character was last open.
 * Only the name and the time are taken; nothing inside the file is read.
 */
async function recentChats(userRoot: string): Promise<PreviewChat[]> {
  const root = join(userRoot, 'chats');
  let directories: string[];
  try { directories = await readdir(root); } catch { return []; }
  const found = await Promise.all(directories.map(async (name) => {
    if (!isPlainFileName(name)) return null;
    let files: string[];
    try { files = await readdir(join(root, name)); } catch { return null; }
    let newest = 0;
    await Promise.all(files.filter((file) => file.endsWith('.jsonl')).map(async (file) => {
      try {
        const at = (await stat(join(root, name, file))).mtimeMs;
        if (at > newest) newest = at;
      } catch { /* a file that vanished between the listing and the stat */ }
    }));
    return newest === 0 ? null : { name, at: newest };
  }));
  const ranked = found.filter((entry): entry is { name: string; at: number } => entry !== null);
  ranked.sort((left, right) => right.at - left.at);
  const top = ranked.slice(0, RECENT_COUNT);
  return Promise.all(top.map(async (entry) => ({
    name: entry.name,
    avatar: await avatarFor(userRoot, entry.name),
    at: new Date(entry.at).toISOString(),
  })));
}

/** A character's card, which SillyTavern names after the character. */
async function avatarFor(userRoot: string, character: string): Promise<string | null> {
  for (const extension of ['.png', '.webp']) {
    const name = `${character}${extension}`;
    if (!isPlainFileName(name)) return null;
    try {
      if ((await stat(join(userRoot, DIRECTORY.avatar, name))).isFile()) return name;
    } catch { /* try the next extension */ }
  }
  return null;
}

export async function previewManifest(userRoot: string): Promise<PreviewManifest> {
  const settings = await readSettings(userRoot);
  const [backgrounds, recent] = await Promise.all([
    newestImages(join(userRoot, DIRECTORY.background), 1),
    recentChats(userRoot),
  ]);
  return {
    background: chosenBackground(settings) ?? backgrounds[0] ?? null,
    theme: themeOf(settings),
    recent,
  };
}

export async function previewImage(userRoot: string, kind: PreviewKind, name: string): Promise<PreviewImage | null> {
  if (!isPlainFileName(name)) return null;
  const contentType = imageTypeFor(name);
  if (!contentType) return null;
  const path = join(userRoot, DIRECTORY[kind], name);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
    return { bytes: await readFile(path), contentType };
  } catch {
    return null;
  }
}

/** SillyTavern's own mark, from whichever version is installed. */
export async function previewLogo(runtimePath: string): Promise<PreviewImage | null> {
  try {
    const path = join(runtimePath, 'public', 'img', 'logo.png');
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
    return { bytes: await readFile(path), contentType: 'image/png' };
  } catch {
    return null;
  }
}
