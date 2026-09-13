import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detectPlatform } from '../../../packages/platform/src/index.js';

export interface BootstrapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: (line: string) => void;
  /** Injectable for tests, so nothing is really launched. */
  readonly spawnImpl?: typeof spawn;
  readonly platform?: NodeJS.Platform;
}

/** Where the built panel lives, for both the server and the build-on-demand check. */
export function panelStaticRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.STM_STATIC_ROOT ?? join(process.cwd(), 'apps', 'manager-panel', 'dist'));
}

/**
 * Build the panel if it has not been built yet.
 *
 * `npm start` on a fresh clone answered every page with "the manager panel has
 * not been built yet" and left the operator to work out `npm run panel:build`
 * on their own. Once the output exists this costs one stat.
 */
export async function ensurePanelBuilt(options: BootstrapOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? ((line: string) => console.log(line));
  const staticRoot = panelStaticRoot(env);
  if (await isFile(join(staticRoot, 'index.html'))) return false;
  logger('[manager] the panel has not been built yet; building it now');
  const runner = options.spawnImpl ?? spawn;
  const code = await new Promise<number | null>((resolvePromise) => {
    const child = runner(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'panel:build'], { stdio: 'inherit', windowsHide: true });
    child.once('error', () => resolvePromise(null));
    child.once('close', (status) => resolvePromise(status));
  });
  if (code === 0 && await isFile(join(staticRoot, 'index.html'))) {
    logger('[manager] the panel is built');
    return true;
  }
  // The API is still worth serving without it, so say what to do rather than
  // refusing to start.
  logger('[manager] the panel could not be built; run "npm run panel:build" and restart');
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
  const logger = options.logger ?? ((line: string) => console.log(line));
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
    logger(`[manager] opened ${url}`);
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
