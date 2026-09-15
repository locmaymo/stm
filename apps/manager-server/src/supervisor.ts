import { spawn, type ChildProcess } from 'node:child_process';
import { describeExit, logEvent, logLineText, STOP_REASON_TEXT, stopReasonCode, type Installation, type LogSink, type ProcessState, type Profile, type StopReason } from '../../../packages/contracts/src/index.js';
import { assertInstallationMarker, RuntimeError, type RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';

export interface ProcessSupervisorOptions {
  readonly runtime: RuntimeManager;
  readonly logger?: LogSink;
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
  private readonly logger: LogSink;
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
  /** Set while a stop this manager asked for is in flight, so the exit can say so. */
  private stopReason: StopReason | null = null;

  public constructor(options: ProcessSupervisorOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
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
    if (this.child) await this.stop('restart');
    // The marker check refuses with a code of its own; keeping it is what lets
    // the panel say which of the two went wrong in the reader's language.
    try { await assertInstallationMarker(installation); }
    catch (error: unknown) { return this.fail(installation.id, error instanceof Error ? error.message : 'The SillyTavern installation marker is invalid', error instanceof RuntimeError ? error.code : undefined); }
    this.current = { status: 'starting', installationId: installation.id, profileId: profile?.id ?? null, pid: null, startedAt: null, error: null };
    this.logger(logEvent('sillytavern.starting', `[sillytavern] starting ${installation.resolvedRef} on 127.0.0.1:8000`, { ref: installation.resolvedRef }));
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
        this.logger(logEvent('sillytavern.legacyHeap', `[sillytavern] using ${heapMb} MiB heap for the legacy public/ runtime`, { heap: heapMb }));
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
      this.logger(logEvent('sillytavern.spawnFailed', `[sillytavern] ${error.message}`, { reason: error.message }));
    });
    child.once('close', (code, signal) => {
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
      const reason = this.stopReason;
      this.stopReason = null;
      const exit = describeExit(code, signal);
      if (this.child === child) {
        this.child = null;
        const crashed = !reason && code !== 0;
        // Written out rather than spread, so a code left over from an earlier
        // failure cannot survive into a state that is no longer a failure.
        this.current = {
          status: crashed ? 'error' : 'stopped',
          installationId: this.current.installationId,
          profileId: this.current.profileId,
          pid: null,
          startedAt: this.current.startedAt,
          error: crashed ? `SillyTavern exited on its own (${exit})` : null,
          ...(crashed ? { errorCode: 'sillytavern_exited' } : {}),
        };
      }
      // "stopped (unknown)" was the same line for a crash, a version switch and
      // the Stop button, which left nothing to act on. A stop this manager
      // asked for names what asked for it; anything else says it was not us.
      this.logger(reason
        ? logEvent(`sillytavern.${stopReasonCode(reason)}`, `[sillytavern] stopped: ${STOP_REASON_TEXT[reason]}`)
        : logEvent('sillytavern.exited', `[sillytavern] exited on its own (${exit})`, { detail: exit }));
    });
    const spawnedAt = Date.now();
    try {
      await this.readinessCheck(child);
      this.current = { ...this.current, status: 'running' };
      // Most of this is SillyTavern loading its dependency tree, which on a
      // hosted volume is thousands of small reads rather than any real work.
      // Saying how long it took makes that visible instead of inferred.
      this.logger(logEvent('sillytavern.ready', `[sillytavern] ready on 127.0.0.1:8000 after ${((Date.now() - spawnedAt) / 1000).toFixed(1)}s`, { seconds: ((Date.now() - spawnedAt) / 1000).toFixed(1) }));
      return this.getState();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'SillyTavern did not become ready';
      await this.stop('startupFailed');
      return this.fail(installation.id, message);
    }
  }

  public async stop(reason: StopReason = 'requested'): Promise<ProcessState> {
    const child = this.child;
    if (!child) { this.current = { ...this.current, status: 'stopped', pid: null }; return this.getState(); }
    this.stopReason = reason;
    this.current = { ...this.current, status: 'stopping' };
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child && child.exitCode === null) child.kill('SIGKILL');
    if (this.activeProfile && this.profileLifecycle) {
      await this.profileLifecycle.persist(this.activeProfile, this.activeProfile.runtimePath, this.activeRuntimeLayout).catch((error: unknown) => { const reason = error instanceof Error ? error.message : 'unknown error'; this.logger(logEvent('profiles.legacySyncFailed', `[profiles] legacy sync failed: ${reason}`, { reason })); });
    }
    this.child = null;
    this.activeProfile = null;
    this.current = { ...this.current, status: 'stopped', pid: null, error: null };
    return this.getState();
  }

  public async restart(reason: StopReason = 'restart'): Promise<ProcessState> { await this.stop(reason); return this.start(); }

  public async startActive(): Promise<ProcessState> { return this.start(); }

  public async close(): Promise<void> { await this.stop('shutdown'); }

  private handleLine(line: string): void {
    const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim();
    if (clean) this.logger(`[sillytavern] ${clean}`);
  }

  private fail(installationId: string | null, error: string, errorCode?: string): ProcessState {
    this.current = { status: 'error', installationId, profileId: null, pid: null, startedAt: null, error, ...(errorCode ? { errorCode } : {}) };
    this.logger(logEvent('sillytavern.failed', `[sillytavern] ${error}`, { reason: error }));
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
