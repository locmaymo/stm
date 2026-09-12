import { spawn, type ChildProcess } from 'node:child_process';
import type { Installation, ProcessState, Profile } from '../../../packages/contracts/src/index.js';
import { assertInstallationMarker, type RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';

export interface ProcessSupervisorOptions {
  readonly runtime: RuntimeManager;
  readonly logger?: (line: string) => void;
  readonly now?: () => Date;
  readonly nodePath?: string;
  readonly profileResolver?: (installation: Installation) => Promise<Profile | null>;
  readonly startupTimeoutMs?: number;
  readonly profileLifecycle?: {
    readonly prepare: (profile: Profile, runtimePath: string) => Promise<'data' | 'public'>;
    readonly persist: (profile: Profile, runtimePath: string, runtimeLayout: 'data' | 'public') => Promise<void>;
    readonly legacyHeapMb?: (profile: Profile, runtimePath: string) => Promise<number | null>;
  };
  /** Test hook; production waits for HTTP on port 8000. */
  readonly readinessCheck?: (child: ChildProcess) => Promise<void>;
  /** Runtime loader and JSONL destination for privacy-safe usage metrics. */
  readonly instrumentationPath?: string;
  readonly metricsFile?: string;
}

export class ProcessSupervisor {
  private readonly runtime: RuntimeManager;
  private readonly logger: (line: string) => void;
  private readonly now: () => Date;
  private readonly nodePath: string;
  private readonly startupTimeoutMs: number;
  private readonly profileResolver: ((installation: Installation) => Promise<Profile | null>) | undefined;
  private readonly profileLifecycle: ProcessSupervisorOptions['profileLifecycle'];
  private readonly readinessCheck: (child: ChildProcess) => Promise<void>;
  private readonly instrumentationPath: string | undefined;
  private readonly metricsFile: string | undefined;
  private child: ChildProcess | null = null;
  private buffer = '';
  private current: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  private activeProfile: Profile | null = null;
  private activeRuntimeLayout: 'data' | 'public' = 'data';

  public constructor(options: ProcessSupervisorOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
    this.nodePath = options.nodePath ?? process.execPath;
    // The first real launch can compile SillyTavern's frontend before port 8000
    // is available, especially on free-tier workspaces.
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000;
    this.profileResolver = options.profileResolver;
    this.profileLifecycle = options.profileLifecycle;
    this.readinessCheck = options.readinessCheck ?? ((child) => waitForHttpReady('http://127.0.0.1:8000/', child, this.startupTimeoutMs));
    this.instrumentationPath = options.instrumentationPath;
    this.metricsFile = options.metricsFile;
  }

  public getState(): ProcessState { return { ...this.current }; }

  public async start(): Promise<ProcessState> {
    if (this.child) return this.getState();
    const installation = await this.runtime.getActiveInstallation();
    if (!installation || installation.status !== 'ready') return this.fail(null, 'Install SillyTavern before starting it');
    const profile = this.profileResolver ? await this.profileResolver(installation) : null;
    return this.startInstallation(installation, profile);
  }

  public async startInstallation(installation: Installation, profile: Profile | null = null): Promise<ProcessState> {
    if (this.child) await this.stop();
    try { await assertInstallationMarker(installation); } catch (error: unknown) { return this.fail(installation.id, error instanceof Error ? error.message : 'The SillyTavern installation marker is invalid'); }
    this.current = { status: 'starting', installationId: installation.id, profileId: profile?.id ?? null, pid: null, startedAt: null, error: null };
    this.logger(`[sillytavern] starting ${installation.resolvedRef} on 127.0.0.1:8000`);
    const args = [
      ...(this.instrumentationPath ? ['--import', this.instrumentationPath] : []),
      'server.js', '--port', '8000', '--browserLaunchEnabled', 'false',
    ];
    let runtimeLayout: 'data' | 'public' = profile?.layout === 'public' ? 'public' : 'data';
    if (profile && this.profileLifecycle) runtimeLayout = await this.profileLifecycle.prepare(profile, installation.runtimePath);
    if (runtimeLayout === 'public' && profile && this.profileLifecycle?.legacyHeapMb) {
      const heapMb = await this.profileLifecycle.legacyHeapMb(profile, installation.runtimePath);
      if (heapMb) {
        args.unshift(`--max-old-space-size=${heapMb}`);
        this.logger(`[sillytavern] using ${heapMb} MiB heap for the legacy public/ runtime`);
      }
    }
    if (profile?.layout === 'data' && runtimeLayout === 'data') args.push('--dataRoot', profile.dataPath, '--configPath', profile.configPath);
    this.activeProfile = profile;
    this.activeRuntimeLayout = runtimeLayout;
    const child = spawn(this.nodePath, args, {
      cwd: installation.runtimePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(this.metricsFile ? { STM_METRICS_FILE: this.metricsFile } : {}),
      },
    });
    this.child = child;
    this.current = { ...this.current, pid: child.pid ?? null, startedAt: this.now().toISOString() };
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
      this.current = { ...this.current, status: 'error', error: error.message };
      this.logger(`[sillytavern] ${error.message}`);
    });
    child.once('close', (code) => {
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
      if (this.child === child) {
        this.child = null;
        this.current = { ...this.current, status: code === 0 ? 'stopped' : 'error', pid: null, error: code === 0 ? null : `SillyTavern exited with code ${code ?? 'unknown'}` };
      }
      this.logger(`[sillytavern] stopped (${code ?? 'unknown'})`);
    });
    try {
      await this.readinessCheck(child);
      this.current = { ...this.current, status: 'running' };
      this.logger('[sillytavern] ready on 127.0.0.1:8000');
      return this.getState();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'SillyTavern did not become ready';
      await this.stop();
      return this.fail(installation.id, message);
    }
  }

  public async stop(): Promise<ProcessState> {
    const child = this.child;
    if (!child) { this.current = { ...this.current, status: 'stopped', pid: null }; return this.getState(); }
    this.current = { ...this.current, status: 'stopping' };
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child && child.exitCode === null) child.kill('SIGKILL');
    if (this.activeProfile && this.profileLifecycle) {
      await this.profileLifecycle.persist(this.activeProfile, this.activeProfile.runtimePath, this.activeRuntimeLayout).catch((error: unknown) => this.logger(`[profiles] legacy sync failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
    this.child = null;
    this.activeProfile = null;
    this.current = { ...this.current, status: 'stopped', pid: null, error: null };
    return this.getState();
  }

  public async restart(): Promise<ProcessState> { await this.stop(); return this.start(); }

  public async startActive(): Promise<ProcessState> { return this.start(); }

  public async close(): Promise<void> { await this.stop(); }

  private handleLine(line: string): void {
    const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim();
    if (clean) this.logger(`[sillytavern] ${clean}`);
  }

  private fail(installationId: string | null, error: string): ProcessState {
    this.current = { status: 'error', installationId, profileId: null, pid: null, startedAt: null, error };
    this.logger(`[sillytavern] ${error}`);
    return this.getState();
  }
}

async function waitForHttpReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`SillyTavern exited during startup (code ${child.exitCode ?? 'unknown'})`);
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      if (response.ok || response.status === 401 || response.status === 302) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('SillyTavern did not become ready on port 8000');
}
