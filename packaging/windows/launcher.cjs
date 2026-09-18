'use strict';

/**
 * The window a Windows user actually sees.
 *
 * This file is the entry point of the single-file executable, and Node runs a
 * SEA entry as CommonJS - which is why it cannot be an ES module. The previous
 * launcher was `launcher.mjs`, so every double-click died on its first `import`
 * with a SyntaxError, showed it for as long as it took the console to close,
 * and left nothing behind but a port that was still listening.
 *
 * So the rules here are: never exit without saying why, never leave the manager
 * running after this window is gone, and always show the address and how to
 * stop rather than assuming someone will find them.
 */

const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { accessSync, readFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { dirname, join } = require('node:path');
const readline = require('node:readline');

/**
 * Where the console is, and where this window will point people.
 *
 * 7860 unless something else on this machine already holds it, in which case
 * the manager steps aside to the next free port - and so does this, to the same
 * one, before the manager is started. Working it out here rather than reading
 * it back out of the manager's output is what lets every line this window
 * prints be right the first time it is printed.
 */
const configuredPort = Number(process.env.STM_PORT);
/** A port somebody wrote down is theirs; nothing here moves off it. */
const pinned = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535;
const DEFAULT_MANAGER_PORT = pinned ? configuredPort : 7860;
let managerPort = DEFAULT_MANAGER_PORT;
let MANAGER_URL = `http://127.0.0.1:${DEFAULT_MANAGER_PORT}`;
const READY_TIMEOUT_MS = 180_000;
const GRACEFUL_STOP_MS = 20_000;

function inSea() {
  try { return require('node:sea').isSea(); } catch { return false; }
}

function exists(path) {
  try { accessSync(path); return true; } catch { return false; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const packaged = inSea();
const launcherDirectory = packaged ? dirname(process.execPath) : __dirname;
const packagedRoot = join(launcherDirectory, 'resources');
const applicationRoot = process.env.STM_APP_ROOT ?? (packaged ? join(packagedRoot, 'app') : join(launcherDirectory, '..', '..'));
const staticRoot = process.env.STM_STATIC_ROOT ?? (packaged ? join(packagedRoot, 'panel') : join(applicationRoot, 'apps', 'manager-panel', 'dist'));
const packagedNode = join(packagedRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const nodeBinary = process.env.STM_NODE_BINARY ?? (packaged && exists(packagedNode) ? packagedNode : process.execPath);
const release = readJson(join(packagedRoot, 'release.json')) ?? readJson(join(applicationRoot, 'package.json')) ?? {};
const dataLocation = process.env.STM_DATA_DIR
  ?? release.dataLocation
  ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'SillyTavernManager') : join(process.env.HOME ?? '', '.sillytavern-manager'));

const compiledEntry = join(applicationRoot, 'apps', 'manager-server', 'src', 'main.js');
const sourceEntry = join(applicationRoot, 'apps', 'manager-server', 'src', 'main.ts');
const serverEntry = exists(compiledEntry) ? compiledEntry : sourceEntry;
const serverArguments = serverEntry.endsWith('.ts') ? ['--import', 'tsx', serverEntry] : [serverEntry];
// A secret only this launcher knows, so closing this window can ask the manager
// to put SillyTavern down properly instead of killing it mid-write.
const shutdownToken = randomBytes(24).toString('base64url');

let server = null;
let stopping = false;
let ready = false;

function line(text = '') { process.stdout.write(`${text}\n`); }

function banner() {
  line();
  line('  SillyTavern Manager' + (release.version ? `  v${release.version}` : ''));
  line('  ' + '-'.repeat(46));
  line(`  Console      ${MANAGER_URL}`);
  line(`  SillyTavern  http://127.0.0.1:8000  (once you start it)`);
  line(`  Shared link  http://127.0.0.1:8001  (asks for the SillyTavern password)`);
  line(`  Your data    ${dataLocation}`);
  line();
  line('  Starting. The console opens in your browser when it is ready.');
  line('  This window has to stay open: it is the manager.');
  line();
}

function readyNotice() {
  line();
  line('  ' + '-'.repeat(46));
  line(`  Ready. Open ${MANAGER_URL}`);
  line('  Press Q or Ctrl+C in this window to stop everything.');
  line('  Closing this window stops it too.');
  line('  ' + '-'.repeat(46));
  line();
}

async function waitForManager() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server === null || server.exitCode !== null) return false;
    try {
      const response = await fetch(`${MANAGER_URL}/api/v1/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return true;
    } catch {
      // The manager installs its dependencies on a first run, which on a slow
      // disk is minutes. Keep waiting rather than reporting a failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function openBrowser() {
  if (process.platform !== 'win32') return;
  try {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', MANAGER_URL], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } catch {
    // A machine with no browser still has the address printed above.
  }
}

/**
 * Stop the manager, then make sure nothing it started is left behind.
 *
 * Windows has no SIGTERM, so killing the child would leave SillyTavern and
 * cloudflared running and port 8000 held by nothing the user can see. The
 * manager is asked over HTTP first, which lets it shut its own children down;
 * the tree kill is only the fallback for a manager that is already wedged.
 */
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  const child = server;
  if (!child || child.exitCode !== null) { process.exit(0); return; }
  line();
  line(`  Stopping (${reason})...`);
  try {
    await fetch(`${MANAGER_URL}/api/v1/shutdown`, {
      method: 'POST',
      headers: { 'x-stm-shutdown-token': shutdownToken },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Fall through to the kill below; it has the same outcome, less politely.
  }
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), GRACEFUL_STOP_MS);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) {
    line('  It did not stop on its own; closing it and anything it started.');
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
  line('  Stopped.');
  process.exit(0);
}

/** Never let a double-clicked window vanish with the reason still on screen. */
function holdWindowOpen(callback) {
  if (!process.stdin.isTTY) { callback(); return; }
  line();
  line('  Press Enter to close this window.');
  const reader = readline.createInterface({ input: process.stdin, output: process.stdout });
  reader.question('', () => { reader.close(); callback(); });
}

function watchKeys() {
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (_text, key) => {
    if (!key) return;
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) void stop('you asked it to');
    if (key.name === 'o') openBrowser();
  });
}

/**
 * What, if anything, already holds the manager port.
 *
 * Starting a second copy produced a window that said Ready - it had found the
 * first copy's health endpoint - and then an EADDRINUSE stack from the manager
 * it had actually started. Asking first turns both of those into one sentence.
 */
async function portHolder() {
  try {
    const response = await fetch(`${MANAGER_URL}/api/v1/health`, { signal: AbortSignal.timeout(2_000) });
    const body = response.ok ? await response.json() : null;
    return body && body.manager ? 'manager' : 'other';
  } catch {
    // Not answering as the manager. It may still be holding the port.
  }
  const held = await new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port: DEFAULT_MANAGER_PORT });
    const settle = (value) => { probe.destroy(); resolve(value); };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
    probe.setTimeout(2_000, () => settle(false));
  });
  return held ? 'other' : null;
}

/** Whether this port can be bound right now, asked by binding it and letting go. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    try { probe.listen(port, '127.0.0.1'); } catch { resolve(false); }
  });
}

/** The first free port at or above `from`, counting up so the number stays recognisable. */
async function nextFreePort(from) {
  for (let port = from; port < from + 64 && port <= 65535; port += 1) {
    if (await portIsFree(port)) return port;
  }
  return null;
}

async function start() {
  const holder = await portHolder();
  if (holder === 'manager') {
    banner();
    line('  SillyTavern Manager is already running, so this window has nothing');
    line(`  to start. Opening ${MANAGER_URL} in your browser.`);
    line();
    line('  Stop it from the window that started it, or from Task Manager.');
    openBrowser();
    holdWindowOpen(() => process.exit(0));
    return;
  }
  if (holder === 'other' && pinned) {
    banner();
    line(`  Port ${DEFAULT_MANAGER_PORT} is set in STM_PORT and another program is already`);
    line('  using it, so the manager cannot listen on it. A port that was asked');
    line('  for is not one to move off, so nothing here moves. To see what has');
    line('  it, run this in a terminal:');
    line();
    line(`      netstat -ano | findstr :${DEFAULT_MANAGER_PORT}`);
    line();
    line('  The last column is the process id; look it up on the Details tab of');
    line('  Task Manager. Or unset STM_PORT and the manager will find its own.');
    holdWindowOpen(() => process.exit(1));
    return;
  }
  let moved = null;
  if (holder === 'other') {
    // Another program has it. That used to end here, which meant a port some
    // unrelated software happened to take was enough to make the manager
    // unusable. Moving costs the reader nothing except a different number in
    // the address, and this window is where that number is written down.
    moved = await nextFreePort(DEFAULT_MANAGER_PORT + 1);
    if (moved === null) {
      banner();
      line(`  Port ${DEFAULT_MANAGER_PORT} is already being used by another program, and no free`);
      line('  port was found near it. To see what has it, run this in a terminal:');
      line();
      line(`      netstat -ano | findstr :${DEFAULT_MANAGER_PORT}`);
      line();
      line('  The last column is the process id; look it up on the Details tab of');
      line('  Task Manager.');
      holdWindowOpen(() => process.exit(1));
      return;
    }
    managerPort = moved;
    MANAGER_URL = `http://127.0.0.1:${managerPort}`;
  }
  banner();
  if (moved !== null) {
    line(`  Port ${DEFAULT_MANAGER_PORT} is being used by another program, so the console is`);
    line(`  on ${managerPort} instead. The address above is the one to use.`);
    line();
  }
  server = spawn(nodeBinary, serverArguments, {
    cwd: applicationRoot,
    env: {
      ...process.env,
      STM_WINDOWS_LAUNCHER: '1',
      STM_APP_ROOT: applicationRoot,
      STM_STATIC_ROOT: staticRoot,
      STM_SHUTDOWN_TOKEN: shutdownToken,
      // The launcher opens the browser once the manager answers, so the manager
      // opening its own would produce two tabs.
      STM_OPEN_BROWSER: '0',
      // Named rather than left to the manager's own search, so this window and
      // the manager cannot disagree about where the console ended up.
      STM_PORT: String(managerPort),
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  server.once('error', (error) => {
    line();
    line(`  The manager could not be started: ${error.message}`);
    line(`  Tried to run: ${nodeBinary}`);
    line(`  From: ${applicationRoot}`);
    holdWindowOpen(() => process.exit(1));
  });

  server.once('exit', (code, signal) => {
    if (stopping) return;
    line();
    if (code === 0) { line('  The manager closed.'); process.exit(0); return; }
    line(`  The manager stopped unexpectedly (${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}).`);
    line('  The lines above this one say why.');
    holdWindowOpen(() => process.exit(code ?? 1));
  });

  void waitForManager().then((up) => {
    if (!up || stopping) return;
    ready = true;
    readyNotice();
    openBrowser();
  });

  watchKeys();
  process.on('SIGINT', () => { void stop('Ctrl+C'); });
  process.on('SIGTERM', () => { void stop('a stop request'); });
  process.on('SIGHUP', () => { void stop('the window closing'); });
}

void start().catch((error) => {
  line();
  line(`  The launcher could not start: ${error && error.message ? error.message : error}`);
  holdWindowOpen(() => process.exit(1));
});

module.exports = { managerUrl: () => MANAGER_URL, isReady: () => ready };
