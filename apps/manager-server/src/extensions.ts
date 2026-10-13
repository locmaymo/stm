import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExtensionGit, ExtensionInfo, ExtensionList, ExtensionScope } from '../../../packages/contracts/src/index.js';

/**
 * The third-party extensions a profile runs, read off the disk.
 *
 * SillyTavern looks in two places, and so does this: the profile's own
 * `extensions/` and the installed copy's `public/scripts/extensions/third-party/`.
 * A folder counts only when it holds a `manifest.json`, which is SillyTavern's
 * own rule, and when both places hold the same name SillyTavern loads the
 * profile's one - the other is listed, marked as shadowed, so nobody wonders
 * why updating it changed nothing.
 *
 * Nothing here writes. Git is asked only about a folder that has a `.git` of
 * its own, and is kept from looking above it: a global extension copied in
 * without one sits inside SillyTavern's own checkout, and asking git there
 * would answer with SillyTavern's commit.
 */

/** How many extensions are measured and asked about at once. */
const CONCURRENCY = 4;
/** Long enough for a slow phone; short enough that one broken repository does not hold the page. */
const GIT_TIMEOUT_MS = 15_000;

export interface ExtensionRoots {
  /** SillyTavern's user directory of the active profile, or null without one. */
  readonly userRoot: string | null;
  /** The installed copy of SillyTavern, or null when none is installed. */
  readonly runtimeRoot: string | null;
}

export interface ListExtensionsOptions {
  readonly gitCommand?: string;
}

interface Candidate {
  readonly name: string;
  readonly scope: ExtensionScope;
  readonly path: string;
}

export async function listExtensions(roots: ExtensionRoots, options: ListExtensionsOptions = {}): Promise<ExtensionList> {
  const gitCommand = options.gitCommand ?? 'git';
  const user = roots.userRoot ? await extensionFolders(join(roots.userRoot, 'extensions'), 'user') : [];
  const global = roots.runtimeRoot ? await extensionFolders(join(roots.runtimeRoot, 'public', 'scripts', 'extensions', 'third-party'), 'global') : [];
  const disabled = roots.userRoot ? await disabledExtensions(join(roots.userRoot, 'settings.json')) : new Set<string>();
  const userNames = new Set(user.map((candidate) => candidate.name));
  const candidates = [...user, ...global];
  const gitAvailable = candidates.length > 0 ? await canRunGit(gitCommand) : true;
  const extensions = await mapPooled(candidates, CONCURRENCY, async (candidate) => describe(candidate, {
    enabled: !disabled.has(extensionKey(candidate.name)),
    shadowed: candidate.scope === 'global' && userNames.has(candidate.name),
    gitCommand: gitAvailable ? gitCommand : null,
  }));
  extensions.sort((left, right) => left.scope === right.scope
    ? left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
    : left.scope === 'user' ? -1 : 1);
  return { extensions, gitAvailable };
}

/** How SillyTavern names a third-party extension in its list of disabled ones. */
export function extensionKey(name: string): string {
  return `third-party/${name}`;
}

/**
 * A remote address as it may be shown: the same address, with any user name,
 * password or token taken out.
 *
 * `git@host:owner/repo` keeps its `git@`, which names the account every such
 * address uses and is no secret; `name:token@host:...` loses the part before
 * the `@`.
 */
export function safeRemote(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.username = '';
      url.password = '';
      return url.toString();
    } catch { return null; }
  }
  return trimmed.replace(/^[^@/]+:[^@/]*@/u, '');
}

/** A manifest's `homePage`, offered as a link only when it is an ordinary web address. */
export function safeHomePage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch { return null; }
}

async function extensionFolders(root: string, scope: ExtensionScope): Promise<Candidate[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const found: Candidate[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    // SillyTavern follows a link to a folder, so a linked extension counts.
    const directory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(path).then((target) => target.isDirectory(), () => false));
    if (!directory) continue;
    if (!await stat(join(path, 'manifest.json')).then((target) => target.isFile(), () => false)) continue;
    found.push({ name: entry.name, scope, path });
  }
  return found;
}

async function disabledExtensions(settingsPath: string): Promise<Set<string>> {
  try {
    const settings = JSON.parse(stripBom(await readFile(settingsPath, 'utf8'))) as unknown;
    const list = isRecord(settings) && isRecord(settings.extension_settings) ? settings.extension_settings.disabledExtensions : null;
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set(); }
}

async function describe(candidate: Candidate, context: { enabled: boolean; shadowed: boolean; gitCommand: string | null }): Promise<ExtensionInfo> {
  const manifest = await readManifest(join(candidate.path, 'manifest.json'));
  const hasGit = await stat(join(candidate.path, '.git')).then(() => true, () => false);
  const [size, git] = await Promise.all([
    measure(candidate.path),
    hasGit && context.gitCommand ? readGit(context.gitCommand, candidate.path) : Promise.resolve(null),
  ]);
  return {
    name: candidate.name,
    key: extensionKey(candidate.name),
    scope: candidate.scope,
    displayName: text(manifest.display_name) ?? candidate.name,
    version: text(manifest.version),
    author: text(manifest.author),
    homePage: safeHomePage(manifest.homePage),
    enabled: context.enabled,
    shadowed: context.shadowed,
    bytes: size.bytes,
    dependencyBytes: size.dependencyBytes,
    hasGit,
    git,
  };
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(stripBom(await readFile(path, 'utf8'))) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * The size of an extension, with what `node_modules` holds counted apart.
 *
 * Links are not followed: a link inside an extension can point anywhere, and
 * whatever it points at is not the extension's to account for.
 */
async function measure(root: string): Promise<{ bytes: number; dependencyBytes: number }> {
  let bytes = 0;
  let dependencyBytes = 0;
  const walk = async (directory: string, dependencies: boolean): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    const files = entries.filter((entry) => entry.isFile());
    const sizes = await Promise.all(files.map((entry) => stat(join(directory, entry.name)).then((target) => target.size, () => 0)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (dependencies) dependencyBytes += total; else bytes += total;
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(directory, entry.name), dependencies || entry.name === 'node_modules');
    }
  };
  await walk(root, false);
  return { bytes, dependencyBytes };
}

async function readGit(gitCommand: string, directory: string): Promise<ExtensionGit | null> {
  try {
    const head = await git(gitCommand, directory, ['log', '-1', '--format=%H%x00%cI%x00%D']);
    const [commit = '', committedAt = '', refs = ''] = head.trim().split('\u0000');
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) return null;
    const branch = refs.split(', ').find((ref) => ref.startsWith('HEAD -> '))?.slice('HEAD -> '.length) ?? null;
    const remote = await git(gitCommand, directory, ['config', '--get', 'remote.origin.url']).then(safeRemote, () => null);
    return { remote, branch, commit, committedAt: committedAt || null };
  } catch { return null; }
}

const gitChecks = new Map<string, Promise<boolean>>();

/** Whether git runs here at all; asked once per process, since that does not change while it runs. */
function canRunGit(gitCommand: string): Promise<boolean> {
  let check = gitChecks.get(gitCommand);
  if (!check) {
    check = new Promise((resolvePromise) => {
      execFile(gitCommand, ['--version'], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error) => resolvePromise(!error));
    });
    gitChecks.set(gitCommand, check);
  }
  return check;
}

function git(gitCommand: string, directory: string, args: readonly string[]): Promise<string> {
  // The ceiling keeps git from walking up to a repository around the folder
  // when the folder's own `.git` turns out not to be one.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory), GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return new Promise((resolvePromise, reject) => {
    execFile(gitCommand, ['-C', directory, ...args], { env, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolvePromise(stdout);
    });
  });
}

async function mapPooled<Item, Result>(items: readonly Item[], limit: number, map: (item: Item) => Promise<Result>): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
