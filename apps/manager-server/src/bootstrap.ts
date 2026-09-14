import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detectPlatform } from '../../../packages/platform/src/index.js';
import { logEvent, logLineText, type LogSink } from '../../../packages/contracts/src/index.js';

export interface BootstrapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: LogSink;
  /** Injectable for tests, so nothing is really launched. */
  readonly spawnImpl?: typeof spawn;
  readonly platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to the panel sources in this checkout. */
  readonly sourceRoots?: readonly string[];
}

/** Where the built panel lives, for both the server and the build-on-demand check. */
export function panelStaticRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.STM_STATIC_ROOT ?? join(process.cwd(), 'apps', 'manager-panel', 'dist'));
}

/** The panel sources, so a build older than them can be noticed. */
function panelSourceRoots(): string[] {
  const panel = join(process.cwd(), 'apps', 'manager-panel');
  return [join(panel, 'src'), join(panel, 'index.html'), join(panel, 'vite.config.ts'), join(process.cwd(), 'packages', 'ui')];
}

/**
 * Build the panel if it has not been built yet, or if it is out of date.
 *
 * `npm start` on a fresh clone answered every page with "the manager panel has
 * not been built yet" and left the operator to work out `npm run panel:build`
 * on their own.
 *
 * Checking only for the file's existence was worse than it sounds: after the
 * first build, every later `npm start` served that same build for good. A panel
 * changed to match a changed API went on calling the old one, got undefined
 * back for everything it asked about, and disabled every control it could not
 * account for - a console where nothing can be typed and no switch moves, with
 * nothing in any log to say why. An installed release has no sources here, so
 * it still costs one stat.
 */
export async function ensurePanelBuilt(options: BootstrapOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const logger: LogSink = options.logger ?? ((line) => console.log(logLineText(line)));
  const staticRoot = panelStaticRoot(env);
  const builtAt = await modifiedAt(join(staticRoot, 'index.html'));
  if (builtAt !== null) {
    if (await newestModified(options.sourceRoots ?? panelSourceRoots()) <= builtAt) return false;
    logger(logEvent('panel.stale', '[manager] the panel is older than the sources it was built from; building it again'));
  } else {
    logger(logEvent('panel.building', '[manager] the panel has not been built yet; building it now'));
  }
  const runner = options.spawnImpl ?? spawn;
  const windows = (options.platform ?? process.platform) === 'win32';
  const code = await new Promise<number | null>((resolvePromise) => {
    let child;
    try {
      // Node will not start a .cmd without a shell, and it says so by throwing
      // rather than by reporting an error - which ended the manager before it
      // listened at all. The arguments here are fixed, so a shell costs
      // nothing. Only the name is needed once a shell resolves it.
      child = runner('npm', ['run', 'panel:build'], { stdio: 'inherit', windowsHide: true, shell: windows });
    } catch {
      resolvePromise(null);
      return;
    }
    child.once('error', () => resolvePromise(null));
    child.once('close', (status) => resolvePromise(status));
  });
  if (code === 0 && await isFile(join(staticRoot, 'index.html'))) {
    logger(logEvent('panel.built', '[manager] the panel is built'));
    return true;
  }
  // The API is still worth serving without it, so say what to do rather than
  // refusing to start.
  logger(logEvent('panel.buildFailed', '[manager] the panel could not be built; run "npm run panel:build" and restart'));
  return false;
}

/**
 * Show the console once it is listening, the way SillyTavern does.
 *
 * Skipped where nobody is at the machine - a container or a hosted studio has
 * no browser to open - and with STM_OPEN_BROWSER=0 for anyone who would rather
 * it stayed out of the way.
 */
export async function openInBrowser(url: string, options: BootstrapOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const logger: LogSink = options.logger ?? ((line) => console.log(logLineText(line)));
  if (env.STM_OPEN_BROWSER === '0') return false;
  const host = options.platform ?? process.platform;
  const platform = detectPlatform({ env, platform: host });
  if (platform === 'docker' || platform === 'modelscope') return false;
  const runner = options.spawnImpl ?? spawn;
  const launcher = platform === 'termux'
    ? { file: 'termux-open-url', args: [url] }
    : host === 'win32'
      ? { file: 'explorer.exe', args: [url] }
      : host === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    const child = runner(launcher.file, launcher.args, { stdio: 'ignore', detached: true, windowsHide: true });
    // A machine with no browser at all must not take the manager down with it,
    // and the exit code is not worth reading: explorer.exe reports failure even
    // when it opened the page.
    child.once('error', () => undefined);
    child.unref();
    logger(logEvent('manager.browserOpened', `[manager] opened ${url}`, { url }));
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** When a file was last written, or null when it is not a file at all. */
async function modifiedAt(path: string): Promise<number | null> {
  try {
    const entry = await stat(path);
    return entry.isFile() ? entry.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The most recent write anywhere under these paths, or 0 for none of them. */
async function newestModified(roots: readonly string[]): Promise<number> {
  let newest = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    let entry;
    try { entry = await stat(path); } catch { return; }
    if (entry.isFile()) { newest = Math.max(newest, entry.mtimeMs); return; }
    if (!entry.isDirectory() || depth === 0) return;
    let names: string[];
    try { names = await readdir(path); } catch { return; }
    for (const name of names) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      await visit(join(path, name), depth - 1);
    }
  };
  for (const root of roots) await visit(root, 8);
  return newest;
}
