import { spawn, type ChildProcess } from 'node:child_process';
import { describeExit, logEvent, logLineText, STOP_REASON_TEXT, stopReasonCode, type Installation, type LogSink, type MessageParams, type ProcessState, type Profile, type StopReason } from '../../../packages/contracts/src/index.js';
import { assertInstallationMarker, RuntimeError, type RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import { SILLYTAVERN_PORT } from './ports.js';
import { defaultHeapMb } from './heap.js';

/**
 * What Node writes when a process has used all the JavaScript memory it was
 * given, just before it aborts. Seen as the last lines SillyTavern prints.
 */
const OUT_OF_MEMORY = /JavaScript heap out of memory|Ineffective mark-compacts near heap limit|Reached heap limit/u;

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
  /**
   * Which port to start SillyTavern on, read at each start.
   *
   * A function rather than a number because the console can move it between
   * one start and the next, and a value captured in the constructor would keep
   * launching on the port it was moved away from.
   */
  readonly port?: () => number;
  /** Test hook; production waits for HTTP on the port above. */
  readonly readinessCheck?: (child: ChildProcess, port: number) => Promise<void>;
  /** Runtime loader and JSONL destination for privacy-safe usage metrics. */
  readonly instrumentationPath?: string;
  readonly metricsFile?: string;
  /** Where the observer puts the start of the last finished reply, for reply notifications. */
  readonly replyFile?: string;
  /** How much JavaScript memory SillyTavern may use, in MiB, read at each start; null for Node's default. See heap.ts. */
  readonly heapMb?: () => number | null;
}

export class ProcessSupervisor {
  private readonly runtime: RuntimeManager;
  private readonly logger: LogSink;
  private readonly now: () => Date;
  private readonly nodePath: string;
  private readonly startupTimeoutMs: number;
  private readonly profileResolver: ((installation: Installation) => Promise<Profile | null>) | undefined;
  private readonly profileLifecycle: ProcessSupervisorOptions['profileLifecycle'];
  private readonly port: () => number;
  private readonly readinessCheck: (child: ChildProcess, port: number) => Promise<void>;
  private readonly instrumentationPath: string | undefined;
  private readonly metricsFile: string | undefined;
  private readonly replyFile: string | undefined;
  private readonly heapMb: () => number | null;
  /** The memory the running SillyTavern was given, in MiB, for saying so if it runs out. */
  private runHeapMb = 0;
  /** Whether the running SillyTavern said it had run out of memory. */
  private outOfMemory = false;
  private child: ChildProcess | null = null;
  private buffer = '';
  private current: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  private activeProfile: Profile | null = null;
  private activeRuntimeLayout: 'data' | 'public' = 'data';
  /** Set while a stop this manager asked for is in flight, so the exit can say so. */
  private stopReason: StopReason | null = null;
  /** Open from a start being asked for until its process exists; see `startInstallation`. */
  private launching: Promise<void> | null = null;

  public constructor(options: ProcessSupervisorOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.now = options.now ?? (() => new Date());
    this.nodePath = options.nodePath ?? process.execPath;
    // The first real launch can compile SillyTavern's frontend before the port
    // is available, especially on free-tier workspaces.
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000;
    this.profileResolver = options.profileResolver;
    this.profileLifecycle = options.profileLifecycle;
    this.port = options.port ?? (() => SILLYTAVERN_PORT);
    this.readinessCheck = options.readinessCheck ?? ((child, port) => waitForHttpReady(`http://127.0.0.1:${port}/`, child, this.startupTimeoutMs));
    this.instrumentationPath = options.instrumentationPath;
    this.metricsFile = options.metricsFile;
    this.replyFile = options.replyFile;
    this.heapMb = options.heapMb ?? (() => null);
  }

  public getState(): ProcessState { return { ...this.current }; }

  public async start(): Promise<ProcessState> {
    if (this.child) return this.getState();
    const installation = await this.runtime.getActiveInstallation();
    if (!installation || installation.status !== 'ready') return this.fail(null, 'Install SillyTavern before starting it');
    const profile = this.profileResolver ? await this.profileResolver(installation) : null;
    return this.startInstallation(installation, profile);
  }

  /**
   * One start at a time, up to the moment there is a process.
   *
   * Preparing a profile can take seconds - a device that shares its data reads
   * storage there - and for that long there is no child to say a start is
   * under way. A second press in that window used to prepare and launch a
   * second SillyTavern on the same port, and both went down over it.
   */
  public async startInstallation(installation: Installation, profile: Profile | null = null): Promise<ProcessState> {
    if (this.launching) { await this.launching; return this.getState(); }
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => { opened = resolve; });
    this.launching = gate;
    const open = (): void => { if (this.launching === gate) this.launching = null; opened(); };
    try { return await this.launch(installation, profile, open); } finally { open(); }
  }

  private async launch(installation: Installation, profile: Profile | null, spawned: () => void): Promise<ProcessState> {
    if (this.child) await this.stop('restart');
    // The marker check refuses with a code of its own; keeping it is what lets
    // the panel say which of the two went wrong in the reader's language.
    try { await assertInstallationMarker(installation); }
    catch (error: unknown) { return this.fail(installation.id, error instanceof Error ? error.message : 'The SillyTavern installation marker is invalid', error instanceof RuntimeError ? error.code : undefined); }
    const port = this.port();
    this.current = { status: 'starting', installationId: installation.id, profileId: profile?.id ?? null, pid: null, startedAt: null, error: null, stepCode: 'process.preparingProfile' };
    this.logger(logEvent('sillytavern.starting', `[sillytavern] starting ${installation.resolvedRef} on 127.0.0.1:${port}`, { ref: installation.resolvedRef, port }));
    const args = [
      ...(this.instrumentationPath ? ['--import', this.instrumentationPath] : []),
      'server.js', '--port', port.toString(10), '--browserLaunchEnabled', 'false',
    ];
    let runtimeLayout: 'data' | 'public' = profile?.layout === 'public' ? 'public' : 'data';
    if (profile && this.profileLifecycle) runtimeLayout = await this.profileLifecycle.prepare(profile, installation.runtimePath);
    let legacyHeap = 0;
    if (runtimeLayout === 'public' && profile && this.profileLifecycle?.legacyHeapMb) {
      legacyHeap = await this.profileLifecycle.legacyHeapMb(profile, installation.runtimePath) ?? 0;
      if (legacyHeap) this.logger(logEvent('sillytavern.legacyHeap', `[sillytavern] using ${legacyHeap} MiB heap for the legacy public/ runtime`, { heap: legacyHeap }));
    }
    // Whichever is larger: a legacy runtime's own need, or what this machine gives every run.
    const givenHeap = this.heapMb() ?? 0;
    const heapMb = Math.max(legacyHeap, givenHeap);
    if (heapMb) args.unshift(`--max-old-space-size=${heapMb}`);
    if (givenHeap && givenHeap >= legacyHeap) this.logger(logEvent('sillytavern.heap', `[sillytavern] SillyTavern may use ${givenHeap} MiB of memory`, { heap: givenHeap }));
    this.runHeapMb = heapMb || defaultHeapMb();
    this.outOfMemory = false;
    if (profile?.layout === 'data' && runtimeLayout === 'data') args.push('--dataRoot', profile.dataPath, '--configPath', profile.configPath);
    this.activeProfile = profile;
    this.activeRuntimeLayout = runtimeLayout;
    this.setStep('process.launching', { ref: installation.resolvedRef });
    const child = spawn(this.nodePath, args, {
      cwd: installation.runtimePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(this.metricsFile ? { STM_METRICS_FILE: this.metricsFile } : {}),
        ...(this.replyFile ? { STM_REPLY_FILE: this.replyFile } : {}),
      },
    });
    this.child = child;
    spawned();
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
      this.current = { ...withoutStep(this.current), status: 'error', error: error.message };
      this.logger(logEvent('sillytavern.spawnFailed', `[sillytavern] ${error.message}`, { reason: error.message }));
    });
    child.once('close', (code, signal) => {
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
      const reason = this.stopReason;
      this.stopReason = null;
      const exit = describeExit(code, signal);
      // Out of memory is a crash with a cause worth naming: "signal SIGABRT"
      // told the reader nothing they could act on.
      const starved = !reason && code !== 0 && this.outOfMemory;
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
          error: starved ? `SillyTavern ran out of memory (${this.runHeapMb} MiB) and stopped` : crashed ? `SillyTavern exited on its own (${exit})` : null,
          ...(crashed ? { errorCode: starved ? 'sillytavern_out_of_memory' : 'sillytavern_exited' } : {}),
        };
      }
      // "stopped (unknown)" was the same line for a crash, a version switch and
      // the Stop button, which left nothing to act on. A stop this manager
      // asked for names what asked for it; anything else says it was not us.
      this.logger(reason
        ? logEvent(`sillytavern.${stopReasonCode(reason)}`, `[sillytavern] stopped: ${STOP_REASON_TEXT[reason]}`)
        : starved
          ? logEvent('sillytavern.outOfMemory', `[sillytavern] ran out of the ${this.runHeapMb} MiB of memory it may use and stopped (${exit})`, { heap: this.runHeapMb, detail: exit })
          : logEvent('sillytavern.exited', `[sillytavern] exited on its own (${exit})`, { detail: exit }));
    });
    const spawnedAt = Date.now();
    try {
      await this.readinessCheck(child, port);
      this.current = withoutStep({ ...this.current, status: 'running' });
      // Most of this is SillyTavern loading its dependency tree, which on a
      // hosted volume is thousands of small reads rather than any real work.
      // Saying how long it took makes that visible instead of inferred.
      this.logger(logEvent('sillytavern.ready', `[sillytavern] ready on 127.0.0.1:${port} after ${((Date.now() - spawnedAt) / 1000).toFixed(1)}s`, { seconds: ((Date.now() - spawnedAt) / 1000).toFixed(1), port }));
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
    this.current = { ...withoutStep(this.current), status: 'stopping', stepCode: 'process.stopping' };
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child && child.exitCode === null) child.kill('SIGKILL');
    if (this.activeProfile && this.profileLifecycle) {
      this.setStep('process.savingData');
      await this.profileLifecycle.persist(this.activeProfile, this.activeProfile.runtimePath, this.activeRuntimeLayout).catch((error: unknown) => { const reason = error instanceof Error ? error.message : 'unknown error'; this.logger(logEvent('profiles.legacySyncFailed', `[profiles] legacy sync failed: ${reason}`, { reason })); });
    }
    this.child = null;
    this.activeProfile = null;
    this.current = withoutStep({ ...this.current, status: 'stopped', pid: null, error: null });
    return this.getState();
  }

  public async restart(reason: StopReason = 'restart'): Promise<ProcessState> { await this.stop(reason); return this.start(); }

  public async startActive(): Promise<ProcessState> { return this.start(); }

  public async close(): Promise<void> { await this.stop('shutdown'); }

  private handleLine(line: string): void {
    const clean = withoutPasswords(line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim());
    if (!clean) return;
    if (OUT_OF_MEMORY.test(clean)) this.outOfMemory = true;
    this.logger(`[sillytavern] ${clean}`);
    if (this.current.status !== 'starting') return;
    const phase = startupPhase(clean);
    if (phase) this.setStep(phase.code, phase.params);
  }

  private setStep(code: string, params?: MessageParams): void {
    if (this.current.status !== 'starting' && this.current.status !== 'stopping') return;
    const next: ProcessState = withoutStep(this.current);
    this.current = { ...next, stepCode: code, ...(params ? { stepParams: params } : {}) };
  }

  private fail(installationId: string | null, error: string, errorCode?: string): ProcessState {
    this.current = { status: 'error', installationId, profileId: null, pid: null, startedAt: null, error, ...(errorCode ? { errorCode } : {}) };
    this.logger(logEvent('sillytavern.failed', `[sillytavern] ${error}`, { reason: error }));
    return this.getState();
  }
}

/**
 * A line with the password taken out of any address that carries one.
 *
 * SillyTavern prints the proxy it was given in full on every start -
 * `Proxy URL is used: http://user:pass@host:port` - and that line lands in a
 * log the console shows, keeps on disk and offers to download.
 */
export function withoutPasswords(line: string): string {
  return line.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/giu, '$1$2:***@');
}

/**
 * The run of SillyTavern a state describes, or null when there is no process.
 *
 * What the door tells a page apart by: a page served by one run and still open
 * after the next has started holds that run's settings, not the files'.
 * `ready` once it has answered.
 */
export function runOf(state: ProcessState): { readonly id: string; readonly ready: boolean } | null {
  if (state.pid === null || !state.startedAt) return null;
  const started = Date.parse(state.startedAt);
  if (!Number.isFinite(started)) return null;
  return { id: `${state.pid.toString(36)}-${started.toString(36)}`, ready: state.status === 'running' };
}

function withoutStep(state: ProcessState): ProcessState {
  const { stepCode: _code, stepParams: _params, ...rest } = state;
  return rest;
}

/**
 * The part of a start a line of SillyTavern's output announces, if any.
 *
 * Matched on the words SillyTavern prints, which are its own and not a
 * contract: a line that stops matching only means the console keeps showing
 * the step before it, never that the start is reported wrongly.
 */
export function startupPhase(line: string): { code: string; params?: MessageParams } | null {
  if (/^Node version:/u.test(line)) return { code: 'process.nodeStarted' };
  if (/^Using config path:/u.test(line)) return { code: 'process.readingConfig' };
  if (/^Using data root:/u.test(line)) return { code: 'process.openingData' };
  if (/Preparing to migrate user data|^Migrating /u.test(line)) return { code: 'process.migratingData' };
  if (/^Content file .* copied/u.test(line)) return { code: 'process.copyingContent' };
  const version = /^SillyTavern (\d[\w.-]*)$/u.exec(line);
  if (version) return { code: 'process.loadingVersion', params: { version: version[1] ?? '' } };
  if (/^Compiling frontend libraries/u.test(line)) return { code: 'process.compilingFrontend' };
  if (/^webpack .*compiled/u.test(line)) return { code: 'process.frontendCompiled' };
  if (/Auto-updating server plugins|^Initializing plugin|server plugin\(s\) are currently loaded/u.test(line)) return { code: 'process.loadingPlugins' };
  // SillyTavern names the port in the line it announces, which is the one
  // answer that is true whatever the console asked for.
  const listening = /is listening on [^:]*:(?:.*:)?(\d+)/u.exec(line);
  if (listening) return { code: 'process.listening', params: { port: listening[1] ?? '' } };
  if (/^Go to: /u.test(line)) return { code: 'process.waitingForAnswer' };
  return null;
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
  throw new Error(`SillyTavern did not become ready on ${new URL(url).host}`);
}
