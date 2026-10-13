import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { ExtensionReconnectPreview, ExtensionScope, ExtensionTrashItem } from '../../../packages/contracts/src/index.js';
import { ExtensionError } from './extension-updates.js';
import { runGit, type FoundExtension } from './extensions.js';

/**
 * Installing, removing, switching and reconnecting third-party extensions.
 *
 * Nothing here deletes an extension on the first click. Removing one moves
 * its folder into the manager's own trash for a week; reconnecting one to its
 * source puts the copy it replaces there too. Only the trash's own clock
 * deletes, and only what is a week old.
 */

/** How long a removed extension can be put back. */
export const TRASH_DAYS = 7;
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;
/** A clone of a large extension over a phone's connection. */
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
/** How many file names of each kind a reconnect preview names. */
const PREVIEW_SAMPLES = 20;
const TRASH_ID = /^\d{13}-[0-9a-f]{12}$/u;

/**
 * An address an extension may be installed from.
 *
 * https only, and nothing in it that could be a secret: no user name or
 * password, and no query or fragment, where tokens also travel. The folder is
 * named after the last part of the path, and only a plain name is accepted, so
 * an address cannot place the clone anywhere but in the extensions folder.
 */
export function parseInstallUrl(value: unknown): { readonly url: string; readonly folder: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw new ExtensionError('extension_url_invalid', 'Enter the address of the extension’s repository');
  // `git@host:owner/repo` is what a copy button often gives, and is ssh.
  if (/^[\w.-]+@[\w.-]+:/u.test(value.trim())) throw new ExtensionError('extension_url_scheme', 'Only https addresses can be installed from');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ExtensionError('extension_url_invalid', 'That is not a web address'); }
  if (url.protocol !== 'https:') throw new ExtensionError('extension_url_scheme', 'Only https addresses can be installed from');
  if (url.username || url.password) throw new ExtensionError('extension_url_credentials', 'The address carries a user name or password; use the public address instead');
  if (url.search || url.hash) throw new ExtensionError('extension_url_invalid', 'The address must not carry a query or a fragment');
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments.at(-1)?.replace(/\.git$/iu, '') ?? '';
  if (segments.length === 0 || !isFolderName(last)) throw new ExtensionError('extension_url_invalid', 'The address does not end in a repository name');
  return { url: url.toString(), folder: last };
}

/** A branch name git would take, and nothing that could be read as an option or a path. */
export function parseBranch(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new ExtensionError('extension_branch_invalid', 'That is not a branch name');
  }
  return value;
}

/** A folder name that is only a name: no separator, no dot of its own, nothing hidden. */
export function isFolderName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value) && !value.includes('..');
}

export interface CloneOptions {
  readonly gitCommand: string;
  /** Where clones are made before they are moved into place. */
  readonly scratch: string;
  /** Which transports git may use; https alone outside tests. */
  readonly protocols?: readonly string[];
}

/**
 * Clone an extension into a scratch folder and check that it is one.
 *
 * Made outside the extensions folder, so SillyTavern never lists a half
 * cloned folder, and refused without a `manifest.json`, which is what makes
 * a folder an extension to SillyTavern.
 */
export async function cloneExtension(options: CloneOptions, url: string, branch: string | null): Promise<string> {
  await mkdir(options.scratch, { recursive: true });
  const target = join(options.scratch, `clone-${randomBytes(6).toString('hex')}`);
  const protocols = options.protocols ?? ['https'];
  try {
    await runGit(options.gitCommand, options.scratch, [
      '-c', 'protocol.allow=never',
      ...protocols.flatMap((protocol) => ['-c', `protocol.${protocol}.allow=always`]),
      ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
      'clone', '--quiet', '--depth', '1', ...(branch ? ['--branch', branch] : []), '--', url, target,
    ], CLONE_TIMEOUT_MS);
  } catch (error: unknown) {
    await rm(target, { recursive: true, force: true });
    throw new ExtensionError('extension_clone_failed', error instanceof Error ? error.message : 'git could not clone the repository');
  }
  if (!await isFile(join(target, 'manifest.json'))) {
    await rm(target, { recursive: true, force: true });
    throw new ExtensionError('extension_not_an_extension', 'That repository has no manifest.json, so it is not a SillyTavern extension');
  }
  return target;
}

/** Put a finished clone where SillyTavern looks, under the name it was given. */
export async function placeExtension(clone: string, root: string, folder: string): Promise<string> {
  if (!isFolderName(folder)) throw new ExtensionError('extension_url_invalid', 'That is not a folder name');
  const destination = join(root, folder);
  if (await exists(destination)) {
    await rm(clone, { recursive: true, force: true });
    throw new ExtensionError('extension_exists', 'An extension with that name is already installed there');
  }
  await mkdir(root, { recursive: true });
  await move(clone, destination);
  return destination;
}

/**
 * The settings file with one extension switched on or off.
 *
 * SillyTavern writes the file with `JSON.stringify(settings, null, 4)`, so
 * writing it back the same way changes nothing but the list - the same bytes
 * SillyTavern itself would write. Null when the extension is already as asked.
 */
export function withExtensionEnabled(text: string, key: string, enabled: boolean): string | null {
  let settings: unknown;
  try { settings = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { throw new ExtensionError('extension_settings_unreadable', 'SillyTavern’s settings file could not be read'); }
  if (!isRecord(settings)) throw new ExtensionError('extension_settings_unreadable', 'SillyTavern’s settings file could not be read');
  const extensionSettings = isRecord(settings.extension_settings) ? settings.extension_settings : {};
  const current = Array.isArray(extensionSettings.disabledExtensions) ? extensionSettings.disabledExtensions : [];
  const disabled = current.includes(key);
  if (disabled === !enabled) return null;
  extensionSettings.disabledExtensions = enabled ? current.filter((item) => item !== key) : [...current, key];
  settings.extension_settings = extensionSettings;
  return JSON.stringify(settings, null, 4);
}

/** Switch an extension on or off in a settings file; SillyTavern must not be running. */
export async function setExtensionEnabled(settingsPath: string, key: string, enabled: boolean): Promise<boolean> {
  let text: string;
  try { text = await readFile(settingsPath, 'utf8'); } catch { throw new ExtensionError('extension_settings_missing', 'SillyTavern has not written its settings yet; open it once first'); }
  const next = withExtensionEnabled(text, key, enabled);
  if (next === null) return false;
  const temporary = `${settingsPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, next, 'utf8');
  await rename(temporary, settingsPath);
  return true;
}

interface TrashMeta {
  readonly name: string;
  readonly displayName: string;
  readonly scope: ExtensionScope;
  readonly originalPath: string;
  readonly removedAt: string;
  readonly bytes: number;
}

/**
 * Removed extensions, kept for a week.
 *
 * Each sits in a folder of its own with a note of where it came from, so it
 * goes back exactly there. Two removals of one name are two entries.
 */
export class ExtensionTrash {
  public constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  public async put(entry: FoundExtension): Promise<ExtensionTrashItem> {
    const removedAt = this.now();
    const id = `${String(removedAt.getTime()).padStart(13, '0')}-${randomBytes(6).toString('hex')}`;
    const folder = join(this.root, id);
    await mkdir(folder, { recursive: true });
    const meta: TrashMeta = {
      name: entry.info.name,
      displayName: entry.info.displayName,
      scope: entry.info.scope,
      originalPath: entry.path,
      removedAt: removedAt.toISOString(),
      bytes: entry.info.bytes + entry.info.dependencyBytes,
    };
    await move(entry.path, join(folder, 'files'));
    await writeFile(join(folder, 'meta.json'), `${JSON.stringify(meta)}\n`, 'utf8');
    return itemOf(id, meta);
  }

  public async list(): Promise<ExtensionTrashItem[]> {
    let ids: string[];
    try { ids = await readdir(this.root); } catch { return []; }
    const items: ExtensionTrashItem[] = [];
    for (const id of ids) {
      const meta = await this.meta(id);
      if (meta) items.push(itemOf(id, meta));
    }
    return items.sort((left, right) => right.removedAt.localeCompare(left.removedAt));
  }

  /** Put a removed extension back where it was; refused when something took its place. */
  public async restore(id: string): Promise<ExtensionTrashItem> {
    const meta = TRASH_ID.test(id) ? await this.meta(id) : null;
    if (!meta) throw new ExtensionError('extension_trash_not_found', 'That removed extension is no longer in the trash');
    if (await exists(meta.originalPath)) throw new ExtensionError('extension_exists', 'An extension with that name is already installed there');
    if (!await exists(dirname(meta.originalPath))) throw new ExtensionError('extension_restore_target_missing', 'The place it was removed from is gone, so it cannot go back');
    await move(join(this.root, id, 'files'), meta.originalPath);
    await rm(join(this.root, id), { recursive: true, force: true });
    return itemOf(id, meta);
  }

  /** Delete what has been in the trash for longer than a week; nothing younger. */
  public async purge(): Promise<number> {
    let removed = 0;
    for (const item of await this.list()) {
      if (Date.parse(item.expiresAt) > this.now().getTime()) continue;
      await rm(join(this.root, item.id), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  private async meta(id: string): Promise<TrashMeta | null> {
    if (!TRASH_ID.test(id)) return null;
    try {
      const parsed = JSON.parse(await readFile(join(this.root, id, 'meta.json'), 'utf8')) as unknown;
      if (!isRecord(parsed) || typeof parsed.name !== 'string' || typeof parsed.displayName !== 'string' || (parsed.scope !== 'user' && parsed.scope !== 'global')
        || typeof parsed.originalPath !== 'string' || typeof parsed.removedAt !== 'string' || typeof parsed.bytes !== 'number') return null;
      return parsed as unknown as TrashMeta;
    } catch { return null; }
  }
}

function itemOf(id: string, meta: TrashMeta): ExtensionTrashItem {
  return {
    id,
    name: meta.name,
    displayName: meta.displayName,
    scope: meta.scope,
    removedAt: meta.removedAt,
    expiresAt: new Date(Date.parse(meta.removedAt) + TRASH_MS).toISOString(),
    bytes: meta.bytes,
  };
}

/**
 * What would change if an extension's folder were replaced by a fresh clone.
 *
 * Compared file by file, leaving out `.git` and `node_modules`. Files only the
 * current folder has are the ones to look at: an extension that keeps the
 * reader's own data in its folder would lose it, and the trash is where it
 * would then be found.
 */
export async function compareFolders(current: string, incoming: string): Promise<Omit<ExtensionReconnectPreview, 'id' | 'name' | 'scope' | 'displayName' | 'url'>> {
  const [before, after] = await Promise.all([fileHashes(current), fileHashes(incoming)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [name, hash] of after) {
    const old = before.get(name);
    if (old === undefined) added.push(name);
    else if (old !== hash) changed.push(name);
    else unchanged += 1;
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name);
  const sample = (names: string[]) => names.sort().slice(0, PREVIEW_SAMPLES);
  return {
    added: added.length, removed: removed.length, changed: changed.length, unchanged,
    samples: { added: sample(added), removed: sample(removed), changed: sample(changed) },
  };
}

async function fileHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') await walk(path);
      } else if (entry.isFile()) {
        // Line endings are git's to choose on checkout; a file that differs
        // only in them is the same file.
        const bytes = (await readFile(path)).toString('latin1').replace(/\r\n/gu, '\n');
        hashes.set(relative(root, path).split(sep).join('/'), createHash('sha256').update(bytes, 'latin1').digest('hex'));
      }
    }
  };
  await walk(root);
  return hashes;
}

/**
 * Move a folder, across file systems when it has to.
 *
 * A rename is instant and is what nearly every move is. The scratch folder
 * can be on another file system than the profile, where a rename is refused;
 * then the folder is copied and the original removed after the copy is whole.
 */
export async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error: unknown) {
    if (!isNodeError(error) || (error.code !== 'EXDEV' && error.code !== 'EPERM')) throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((target) => target.isFile(), () => false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
