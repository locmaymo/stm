import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { describeExit, logEvent, logLineText, STOP_REASON_TEXT, stopReasonCode, type LogSink, type StopReason, type TunnelMode, type TunnelState } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const execFileAsync = promisify(execFile);
const CLOUDFLARED_RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

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
  private child: ChildProcess | null = null;
  private token: string | undefined;
  private buffer = '';
  private state: TunnelState = { mode: 'off', status: 'stopped', url: null, startedAt: null, error: null };
  /** Set while a stop this manager asked for is in flight, so the exit can say so. */
  private stopReason: StopReason | null = null;

  public constructor(options: TunnelManagerOptions) {
    this.paths = options.paths;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.configuredBinaryPath = options.binaryPath ?? this.env.STM_CLOUDFLARED_PATH;
    this.targetUrl = options.targetUrl ?? 'http://127.0.0.1:8001';
    this.beforeStart = options.beforeStart;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  public getState(): TunnelState { return { ...this.state }; }

  public async start(mode: Exclude<TunnelMode, 'off'> = 'quick', token?: string): Promise<TunnelState> {
    if (this.child) return this.getState();
    try { await this.beforeStart?.(); } catch (error: unknown) { return this.fail(mode, error instanceof Error ? error.message : 'Tunnel security requirements are not met'); }
    const selectedToken = token?.trim() || this.token;
    if (mode === 'named' && !selectedToken) return this.fail(mode, 'A Named Tunnel token is required');
    if (mode === 'named') this.token = selectedToken;
    let binary: string;
    try {
      binary = await this.ensureBinary();
    } catch (error: unknown) {
      return this.fail(mode, error instanceof Error ? error.message : 'cloudflared is unavailable');
    }
    const args = mode === 'quick'
      ? ['tunnel', '--no-autoupdate', '--url', this.targetUrl]
      : ['tunnel', '--no-autoupdate', 'run', '--token', selectedToken!];
    this.state = { mode, status: 'starting', url: null, startedAt: this.now().toISOString(), error: null };
    const target = this.targetUrl.replace(/^https?:\/\//u, '');
    this.logger(mode === 'quick'
      ? logEvent('cloudflared.startingQuick', `[cloudflared] starting Quick Tunnel to ${target}`, { target })
      : logEvent('cloudflared.startingNamed', `[cloudflared] starting Named Tunnel to ${target}`, { target }));
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.env });
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
      if (this.child === child) {
        this.child = null;
        if (this.state.status !== 'error' && this.state.status !== 'stopped') {
          this.state = { ...this.state, status: reason || code === 0 ? 'stopped' : 'error', error: reason || code === 0 ? null : `cloudflared exited on its own (${exit})` };
        }
      }
      this.logger(reason
        ? logEvent(`cloudflared.${stopReasonCode(reason)}`, `[cloudflared] stopped: ${STOP_REASON_TEXT[reason]}`)
        : logEvent('cloudflared.exited', `[cloudflared] exited on its own (${exit})`, { detail: exit }));
    });
    return this.getState();
  }

  public async stop(reason: StopReason = 'requested'): Promise<TunnelState> {
    const child = this.child;
    if (!child) { this.state = { ...this.state, status: 'stopped', url: null }; return this.getState(); }
    this.stopReason = reason;
    this.state = { ...this.state, status: 'stopped', url: null, error: null };
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child && child.exitCode === null) child.kill('SIGKILL');
    this.child = null;
    return this.getState();
  }

  public async close(): Promise<void> { await this.stop('shutdown'); }

  public async restart(reason: StopReason = 'restart'): Promise<TunnelState> {
    const mode = this.state.mode;
    if (mode === 'off') return this.getState();
    await this.stop(reason);
    return this.start(mode);
  }

  private handleLine(line: string): void {
    const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim();
    if (!clean) return;
    const url = /https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com(?:\/[^\s]*)?/u.exec(clean)?.[0];
    if (url && this.state.mode === 'quick') this.state = { ...this.state, status: 'running', url };
    this.logger(`[cloudflared] ${clean}`);
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

  private async findBinary(): Promise<string | null> {
    const candidates = [this.configuredBinaryPath, join(this.paths.bin, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.includes('/') || candidate.includes('\\')) {
        try { await access(candidate); return candidate; } catch { continue; }
      }
      try {
        await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [candidate], { env: this.env });
        return candidate;
      } catch { continue; }
    }
    return null;
  }

  private fail(mode: Exclude<TunnelMode, 'off'>, error: string): TunnelState {
    this.state = { mode, status: 'error', url: null, startedAt: null, error };
    this.logger(logEvent('cloudflared.failed', `[cloudflared] ${error}`, { reason: error }));
    return this.getState();
  }
}
