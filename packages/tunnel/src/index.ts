import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { describeExit, logEvent, logLineText, STOP_REASON_TEXT, stopReasonCode, type LogSink, type StopReason, type TunnelMode, type TunnelState } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const execFileAsync = promisify(execFile);
const CLOUDFLARED_RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
/** What the tunnel should be doing, so a manager restart does not take the link down with it. */
const TUNNEL_STATE_FILE = 'tunnel-config.json';
const TUNNEL_SCHEMA_VERSION = 1 as const;
/**
 * How long to wait before reconnecting, per consecutive failure.
 *
 * cloudflared keeps its own edge connections alive, so reaching this at all
 * means the process itself went away - the host slept, the network dropped for
 * longer than cloudflared tolerates, or something killed it. Retrying at once
 * is right for the first case and wrong for a machine that is simply offline,
 * so the wait grows and then sits at a minute.
 */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

interface StoredTunnelState {
  readonly schemaVersion: 1;
  readonly mode: TunnelMode;
  readonly token: string | null;
}

/**
 * Which cloudflared build this machine needs.
 *
 * Cloudflare ships a single static binary per platform, except on macOS where
 * it is only a .tgz - unpacking that would need a dependency, so point at
 * Homebrew rather than failing somewhere obscure later.
 */
function cloudflaredAsset(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): { file: string; exe: string } {
  const mapped = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[architecture as 'x64' | 'arm64' | 'arm' | 'ia32'];
  if (!mapped) throw new Error(`cloudflared has no build for the ${architecture} architecture`);
  if (platform === 'win32') return { file: `cloudflared-windows-${mapped}.exe`, exe: 'cloudflared.exe' };
  if (platform === 'darwin') throw new Error('Install cloudflared with `brew install cloudflared`, then set STM_CLOUDFLARED_PATH.');
  return { file: `cloudflared-linux-${mapped}`, exe: 'cloudflared' };
}

/** An ELF executable with a fixed load address, which Android's loader will not run. */
const ELF_TYPE_FIXED_ADDRESS = 2;
/** Termux's own prefix, for the installs that start without its environment. */
const TERMUX_PREFIX = '/data/data/com.termux/files/usr';
/** How long to let Termux's package manager work before giving up on it. */
const PACKAGE_INSTALL_TIMEOUT_MS = 300_000;

/**
 * Whether Android can start the file at `path` by itself.
 *
 * Android runs position-independent executables only, and Cloudflare's own
 * Linux builds are not position-independent. One started directly on Termux
 * exits at once with
 *
 *   error: "<path>/cloudflared" has unexpected e_type: 2
 *
 * which reads like a broken download and is not one - no retry can fix it. The
 * file is fine; only the way it is started has to change, and `termux-chroot`
 * from the `proot` package starts exactly this kind of binary. So this answers
 * one question: run it directly, or run it through proot.
 */
async function startsOnAndroid(path: string, termux: boolean): Promise<boolean> {
  if (!termux) return true;
  const header = Buffer.alloc(18);
  try {
    const handle = await open(path, 'r');
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  } catch {
    // Unreadable is not the same as unusable. Leave the answer to the loader.
    return true;
  }
  // A wrapper script, or anything else that is not an ELF binary, is the
  // loader's business rather than this check's.
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  const type = header[5] === 2 ? header.readUInt16BE(16) : header.readUInt16LE(16);
  return type !== ELF_TYPE_FIXED_ADDRESS;
}

/**
 * The public address in a line of cloudflared output, without any path.
 *
 * cloudflared announces the address once in a banner, and then names it again
 * in every request line it logs - including the failures, as `dest=https://
 * host/user/images/Assistant/....mp4`. The pattern used to allow a path after
 * the hostname, so whichever file someone had just opened was appended to the
 * public link shown in the console, and the link changed again the next time
 * anything was logged. The address is the origin; the path belongs to whoever
 * was browsing.
 */
export function parseTunnelUrl(line: string): string | undefined {
  return /https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.trycloudflare\.com/u.exec(line)?.[0];
}

export interface TunnelManagerOptions {
  readonly paths: PlatformPaths;
  /**
   * What cloudflared publishes. This is the access gateway, never SillyTavern
   * itself: a tunnel points at whatever answers, and SillyTavern answers with
   * no password of its own.
   */
  readonly targetUrl?: string;
  readonly logger?: LogSink;
  readonly now?: () => Date;
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly beforeStart?: () => Promise<void>;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injectable for tests, so no real cloudflared has to be launched. */
  readonly spawnImpl?: typeof spawn;
  /** How long to wait before each reconnect attempt; shortened by tests. */
  readonly reconnectDelaysMs?: readonly number[];
}

export class TunnelManager {
  private readonly paths: PlatformPaths;
  private readonly logger: LogSink;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configuredBinaryPath: string | undefined;
  private readonly targetUrl: string;
  private readonly beforeStart: (() => Promise<void>) | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly reconnectDelaysMs: readonly number[];
  private child: ChildProcess | null = null;
  /** Whether the running child is proot rather than cloudflared itself. */
  private wrapped = false;
  private token: string | undefined;
  private buffer = '';
  private state: TunnelState = { mode: 'off', status: 'stopped', url: null, startedAt: null, error: null };
  /** Set while a stop this manager asked for is in flight, so the exit can say so. */
  private stopReason: StopReason | null = null;
  /** The pending reconnect, and how many have failed in a row before it. */
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  /** Set once the manager is shutting down, so nothing reconnects behind it. */
  private closed = false;

  public constructor(options: TunnelManagerOptions) {
    this.paths = options.paths;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.configuredBinaryPath = options.binaryPath ?? this.env.STM_CLOUDFLARED_PATH;
    this.targetUrl = options.targetUrl ?? 'http://127.0.0.1:8001';
    this.beforeStart = options.beforeStart;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : RECONNECT_DELAYS_MS;
  }

  public getState(): TunnelState { return { ...this.state }; }

  public async start(mode: Exclude<TunnelMode, 'off'> = 'quick', token?: string): Promise<TunnelState> {
    if (this.child) return this.getState();
    this.clearReconnect();
    try { await this.beforeStart?.(); } catch (error: unknown) { return this.fail(mode, error instanceof Error ? error.message : 'Tunnel security requirements are not met'); }
    const selectedToken = token?.trim() || this.token;
    if (mode === 'named' && !selectedToken) return this.fail(mode, 'A Named Tunnel token is required');
    if (mode === 'named') this.token = selectedToken;
    let plan: Awaited<ReturnType<TunnelManager['launchPlan']>>;
    try {
      plan = await this.launchPlan();
    } catch (error: unknown) {
      return this.fail(mode, error instanceof Error ? error.message : 'cloudflared is unavailable');
    }
    // A phone is where QUIC is blocked and IPv6 is half-configured, and
    // cloudflared answers both by sitting at "Registering tunnel" until it gives
    // up. HTTP/2 over IPv4 is the combination that connects there.
    const mobile = this.paths.platform === 'termux' ? ['--protocol', 'http2', '--edge-ip-version', '4'] : [];
    const args = [...plan.prefix, 'tunnel', '--no-autoupdate', ...mobile, ...(mode === 'quick'
      ? ['--url', this.targetUrl]
      : ['run', '--token', selectedToken!])];
    await this.remember(mode, mode === 'named' ? selectedToken ?? null : null);
    this.state = { mode, status: 'starting', url: null, startedAt: this.now().toISOString(), error: null };
    const target = this.targetUrl.replace(/^https?:\/\//u, '');
    this.logger(mode === 'quick'
      ? logEvent('cloudflared.startingQuick', `[cloudflared] starting Quick Tunnel to ${target}`, { target })
      : logEvent('cloudflared.startingNamed', `[cloudflared] starting Named Tunnel to ${target}`, { target }));
    // proot keeps cloudflared as a child of its own, and a signal sent to the
    // wrapper alone leaves the tunnel running. Its own process group is what
    // makes stopping it stop the tunnel too, without a `pkill` that would also
    // take down a cloudflared nobody here started.
    const child = this.spawnImpl(plan.command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: plan.env, ...(plan.wrapped ? { detached: true } : {}) });
    this.wrapped = plan.wrapped;
    this.child = child;
    const consume = (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/u);
      this.buffer = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', (error) => {
      this.logger(logEvent('cloudflared.spawnFailed', `[cloudflared] ${error.message}`, { reason: error.message }));
      this.state = { ...this.state, status: 'error', error: 'cloudflared could not start' };
      this.child = null;
    });
    child.once('close', (code, signal) => {
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
      const reason = this.stopReason;
      this.stopReason = null;
      const exit = describeExit(code, signal);
      const owned = this.child === child;
      if (owned) {
        this.child = null;
        if (this.state.status !== 'error' && this.state.status !== 'stopped') {
          this.state = { ...this.state, status: reason || code === 0 ? 'stopped' : 'error', error: reason || code === 0 ? null : `cloudflared exited on its own (${exit})` };
        }
      }
      this.logger(reason
        ? logEvent(`cloudflared.${stopReasonCode(reason)}`, `[cloudflared] stopped: ${STOP_REASON_TEXT[reason]}`)
        : logEvent('cloudflared.exited', `[cloudflared] exited on its own (${exit})`, { detail: exit }));
      // Nobody asked for this. The link is what people have open, so put it
      // back rather than waiting for someone to notice the switch moved.
      if (owned && !reason) this.scheduleReconnect(mode);
    });
    return this.getState();
  }

  public async stop(reason: StopReason = 'requested'): Promise<TunnelState> {
    this.clearReconnect();
    const child = this.child;
    if (!child) { this.state = { ...this.state, status: 'stopped', url: null }; return this.getState(); }
    this.stopReason = reason;
    this.state = { ...this.state, status: 'stopped', url: null, error: null };
    this.signal(child, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child && child.exitCode === null) this.signal(child, 'SIGKILL');
    this.child = null;
    return this.getState();
  }

  /**
   * Shut down without forgetting that the tunnel was wanted.
   *
   * The manager going down is not the operator turning the tunnel off, so the
   * stored mode survives and `resume` brings it back on the next start.
   */
  public async close(): Promise<void> {
    this.closed = true;
    await this.stop('shutdown');
  }

  public async restart(reason: StopReason = 'restart'): Promise<TunnelState> {
    const mode = this.state.mode;
    if (mode === 'off') return this.getState();
    await this.stop(reason);
    return this.start(mode);
  }

  /**
   * Turn the tunnel off, and remember that it is off.
   *
   * This is the only path that forgets the mode. Everything else - a restart, a
   * restore, the manager shutting down - leaves it stored, because none of them
   * mean the operator no longer wants a public address.
   */
  public async disable(): Promise<TunnelState> {
    await this.remember('off', null);
    const state = await this.stop('requested');
    this.state = { ...state, mode: 'off' };
    return this.getState();
  }

  /**
   * Start the tunnel again if it was on when the manager last went down.
   *
   * A Quick Tunnel gets a fresh address every time cloudflared starts, so this
   * is what keeps a manager restart from silently leaving the link dead; with a
   * Named Tunnel the address is the same one as before.
   */
  public async resume(): Promise<TunnelState> {
    const stored = await this.readStored();
    if (!stored || stored.mode === 'off') return this.getState();
    if (stored.mode === 'named') this.token = stored.token ?? undefined;
    this.logger(logEvent('cloudflared.resuming', '[cloudflared] restoring the tunnel that was running before'));
    const state = await this.start(stored.mode, stored.token ?? undefined);
    if (state.status === 'error') this.scheduleReconnect(stored.mode);
    return state;
  }

  private handleLine(line: string): void {
    const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim();
    if (!clean) return;
    const url = parseTunnelUrl(clean);
    if (url && this.state.mode === 'quick') this.state = { ...this.state, status: 'running', url, error: null };
    // A Named Tunnel never announces a trycloudflare address - its hostname is
    // the one configured in Cloudflare - so without this it stayed at
    // "starting" for as long as it ran, and nothing could tell a working tunnel
    // from one that never came up.
    if (this.state.mode === 'named' && /registered tunnel connection/iu.test(clean)) this.state = { ...this.state, status: 'running', error: null };
    if (this.state.status === 'running') this.reconnectAttempt = 0;
    this.logger(`[cloudflared] ${clean}`);
  }

  /**
   * Bring the tunnel back after an exit nobody asked for.
   *
   * The attempt itself can fail - the machine may still be offline - so a
   * failed attempt schedules the next one rather than giving up.
   */
  private scheduleReconnect(mode: Exclude<TunnelMode, 'off'>): void {
    if (this.closed || this.reconnectTimer || this.child) return;
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)] ?? 60_000;
    this.reconnectAttempt += 1;
    const seconds = Math.round(delay / 1000);
    this.logger(logEvent('cloudflared.reconnecting', `[cloudflared] reconnecting in ${seconds}s`, { seconds }));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(mode).then((state) => { if (state.status === 'error') this.scheduleReconnect(mode); }).catch(() => this.scheduleReconnect(mode));
    }, delay);
    // The manager must still be able to exit while one of these is pending.
    this.reconnectTimer.unref();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Record what the tunnel should be doing, for the next time the manager starts. */
  private async remember(mode: TunnelMode, token: string | null): Promise<void> {
    const stored: StoredTunnelState = { schemaVersion: TUNNEL_SCHEMA_VERSION, mode, token };
    const target = join(this.paths.state, TUNNEL_STATE_FILE);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.paths.state, { recursive: true });
      // The Named Tunnel token is a credential, so it gets the same treatment
      // as the R2 keys next to it rather than a world-readable file.
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      // Not being able to remember this is not a reason to refuse to open the
      // tunnel; it only costs the automatic restore on the next start.
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger(logEvent('cloudflared.stateNotSaved', `[cloudflared] the tunnel setting could not be saved: ${reason}`, { reason }));
    }
  }

  private async readStored(): Promise<StoredTunnelState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, TUNNEL_STATE_FILE), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== TUNNEL_SCHEMA_VERSION) return null;
      const mode = record.mode;
      if (mode !== 'off' && mode !== 'quick' && mode !== 'named') return null;
      const token = typeof record.token === 'string' && record.token.trim() ? record.token.trim() : null;
      if (mode === 'named' && !token) return null;
      return { schemaVersion: TUNNEL_SCHEMA_VERSION, mode, token };
    } catch {
      return null;
    }
  }

  /**
   * The cloudflared binary, downloaded on first use if it is not here yet.
   *
   * Requiring the operator to install it first meant the tunnel simply did not
   * work on Termux, or anywhere else it was missing, and it was the only reason
   * the container image had to bake the binary in. It is one static file, so
   * fetching it once into the manager's own bin directory costs less than every
   * install carrying it.
   */
  public async ensureBinary(): Promise<string> {
    const existing = await this.findBinary();
    if (existing) return existing;
    if (this.paths.platform === 'termux') {
      // Termux packages a build of cloudflared that Android starts by itself.
      // It costs one command and a sixth of the download, so it is worth
      // asking for before falling back to Cloudflare's own build under proot.
      if (await this.installPackage('cloudflared')) {
        const packaged = await this.findBinary();
        if (packaged) return packaged;
      }
    }
    const asset = cloudflaredAsset();
    const target = join(this.paths.bin, asset.exe);
    const temporary = `${target}.${randomUUID()}.part`;
    await mkdir(this.paths.bin, { recursive: true });
    this.logger(logEvent('cloudflared.downloading', `[cloudflared] downloading ${asset.file}`, { file: asset.file }));
    const response = await this.fetchImpl(`${CLOUDFLARED_RELEASE}/${asset.file}`, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`cloudflared could not be downloaded (HTTP ${response.status})`);
    try {
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(temporary, { mode: 0o755 }));
      await rename(temporary, target);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
    if (process.platform !== 'win32') await chmod(target, 0o755);
    this.logger(logEvent('cloudflared.installed', `[cloudflared] installed to ${target}`, { path: target }));
    return target;
  }

  /**
   * The cloudflared to use, preferring one this device can start unaided.
   *
   * On Android a build that needs proot still works, so it is a fallback here
   * rather than a rejection: the launch plan wraps it. Anywhere else every
   * candidate starts unaided and the first one found wins, as before.
   */
  private async findBinary(): Promise<string | null> {
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const termux = this.paths.platform === 'termux';
    let needsProot: string | null = null;
    for (const candidate of [this.configuredBinaryPath, join(this.paths.bin, exe), exe]) {
      if (!candidate) continue;
      const path = await this.locate(candidate);
      if (!path) continue;
      if (await startsOnAndroid(path, termux)) return candidate;
      needsProot ??= candidate;
    }
    return needsProot;
  }

  /**
   * How to start cloudflared here: what to run, what to put in front of the
   * tunnel arguments, and the environment it needs.
   *
   * Android is the only place this is not simply the binary itself. Cloudflare
   * publishes no build Android starts on its own, so the one downloaded here
   * runs under `termux-chroot`, which is what the `proot` package is for. Inside
   * that view of the filesystem the usual certificate paths do not exist, so the
   * bundle Termux ships is named outright - without it every edge connection
   * fails to verify and the tunnel never comes up.
   */
  private async launchPlan(): Promise<{ command: string; prefix: readonly string[]; env: NodeJS.ProcessEnv; wrapped: boolean }> {
    const binary = await this.ensureBinary();
    const plan = { command: binary, prefix: [] as readonly string[], env: this.env, wrapped: false };
    if (this.paths.platform !== 'termux' || await startsOnAndroid(await this.locate(binary) ?? binary, true)) return plan;
    const chroot = await this.findChroot() ?? (await this.installPackage('proot') ? await this.findChroot() : null);
    if (!chroot) throw new Error('cloudflared needs proot on Android. Install it with `pkg install proot`, then turn the tunnel on again.');
    this.logger(logEvent('cloudflared.throughProot', '[cloudflared] starting it through termux-chroot, which is how Android runs this build'));
    const certificates = await this.locate(join(this.env.PREFIX ?? TERMUX_PREFIX, 'etc', 'tls', 'cert.pem'));
    return {
      command: chroot,
      prefix: [binary],
      env: certificates ? { ...this.env, SSL_CERT_FILE: certificates } : this.env,
      wrapped: true,
    };
  }

  /** Where `proot` puts termux-chroot, which is next to Termux's own programs. */
  private async findChroot(): Promise<string | null> {
    const prefix = this.env.PREFIX;
    return (prefix ? await this.locate(join(prefix, 'bin', 'termux-chroot')) : null) ?? await this.locate('termux-chroot');
  }

  /**
   * Install one Termux package, if this is Termux and `pkg` is there to do it.
   *
   * Nobody opened the manager to set up a tunnel dependency by hand, so this
   * asks for what is missing rather than telling the operator to. It answers
   * whether the package is now there, and never throws: every caller has
   * somewhere else to go.
   */
  private async installPackage(name: string): Promise<boolean> {
    if (this.paths.platform !== 'termux') return false;
    if (!await this.locate('pkg')) return false;
    this.logger(logEvent('cloudflared.installingPackage', `[cloudflared] installing ${name} with pkg`, { package: name }));
    try {
      await execFileAsync('pkg', ['install', '-y', name], { env: this.env, timeout: PACKAGE_INSTALL_TIMEOUT_MS });
      return true;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger(logEvent('cloudflared.packageNotInstalled', `[cloudflared] ${name} could not be installed: ${reason}`, { package: name, reason }));
      return false;
    }
  }

  /** Where a candidate actually is, whether it is a path or a name on PATH. */
  private async locate(candidate: string): Promise<string | null> {
    if (candidate.includes('/') || candidate.includes('\\')) {
      try { await access(candidate); return candidate; } catch { return null; }
    }
    try {
      const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [candidate], { env: this.env });
      return stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? null;
    } catch { return null; }
  }

  /** Signal the tunnel, taking the process group with it when proot is in front. */
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (this.wrapped && typeof child.pid === 'number') {
      try { process.kill(-child.pid, signal); return; } catch { /* the group is already gone, or this is not POSIX */ }
    }
    child.kill(signal);
  }

  private fail(mode: Exclude<TunnelMode, 'off'>, error: string): TunnelState {
    this.state = { mode, status: 'error', url: null, startedAt: null, error };
    this.logger(logEvent('cloudflared.failed', `[cloudflared] ${error}`, { reason: error }));
    return this.getState();
  }
}
