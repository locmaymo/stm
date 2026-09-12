/* global AbortSignal, fetch, setTimeout */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherDirectory = process.isSea ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url));
const packagedRoot = join(launcherDirectory, 'resources');
const applicationRoot = process.env.STM_APP_ROOT ?? (process.isSea ? join(packagedRoot, 'app') : join(launcherDirectory, '..', '..'));
const staticRoot = process.env.STM_STATIC_ROOT ?? (process.isSea ? join(packagedRoot, 'panel') : join(applicationRoot, 'apps', 'manager-panel', 'dist'));
const packagedNode = process.platform === 'win32' ? join(packagedRoot, 'runtime', 'node.exe') : join(packagedRoot, 'runtime', 'node');
const nodeBinary = process.env.STM_NODE_BINARY ?? (process.isSea ? packagedNode : 'node');
const compiledEntry = join(applicationRoot, 'apps', 'manager-server', 'src', 'main.js');
const sourceEntry = join(applicationRoot, 'apps', 'manager-server', 'src', 'main.ts');
const serverEntry = await fileExists(compiledEntry) ? compiledEntry : sourceEntry;
const serverArguments = serverEntry.endsWith('.ts') ? ['--import', 'tsx', serverEntry] : [serverEntry];
const server = spawn(nodeBinary, serverArguments, {
  cwd: applicationRoot,
  env: { ...process.env, STM_WINDOWS_LAUNCHER: '1', STM_APP_ROOT: applicationRoot, STM_STATIC_ROOT: staticRoot },
  stdio: 'inherit',
  windowsHide: true,
});

const openBrowser = () => {
  if (process.platform !== 'win32') return;
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:7860'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
};

void waitForManager().then(openBrowser).catch(() => undefined);
server.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
process.once('SIGINT', () => server.kill('SIGINT'));
process.once('SIGTERM', () => server.kill('SIGTERM'));

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForManager() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:7860/api/v1/health', { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // The manager is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('The manager did not become ready within 30 seconds');
}
