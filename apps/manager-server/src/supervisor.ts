import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { Installation, ProcessState } from '../../../packages/contracts/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';

export interface ProcessSupervisorOptions {
  readonly runtime: RuntimeManager;
  readonly logger?: (line: string) => void;
  readonly now?: () => Date;
  readonly nodePath?: string;
}

export class ProcessSupervisor {
  private readonly runtime: RuntimeManager;
  private readonly logger: (line: string) => void;
  private readonly now: () => Date;
  private readonly nodePath: string;
  private child: ChildProcess | null = null;
  private buffer = '';
  private current: ProcessState = { status: 'stopped', installationId: null, pid: null, startedAt: null, error: null };

  public constructor(options: ProcessSupervisorOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
    this.nodePath = options.nodePath ?? process.execPath;
  }

  public getState(): ProcessState { return { ...this.current }; }

  public async start(): Promise<ProcessState> {
    if (this.child) return this.getState();
    const installation = await this.runtime.getActiveInstallation();
    if (!installation || installation.status !== 'ready') return this.fail(null, 'Install SillyTavern before starting it');
    return this.startInstallation(installation);
  }

  public async startInstallation(installation: Installation): Promise<ProcessState> {
    if (this.child) await this.stop();
    try { await stat(installation.markerPath); } catch { return this.fail(installation.id, 'The SillyTavern installation marker is missing'); }
    this.current = { status: 'starting', installationId: installation.id, pid: null, startedAt: null, error: null };
    this.logger(`[sillytavern] starting ${installation.resolvedRef} on 127.0.0.1:8000`);
    const child = spawn(this.nodePath, ['server.js', '--port', '8000', '--listen', 'false', '--browserLaunchEnabled', 'false'], {
      cwd: installation.runtimePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
    // A successful spawn is sufficient to expose the process state. SillyTavern's
    // own startup diagnostics arrive through the shared log stream.
    this.current = { ...this.current, status: 'running' };
    return this.getState();
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
    this.child = null;
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
    this.current = { status: 'error', installationId, pid: null, startedAt: null, error };
    this.logger(`[sillytavern] ${error}`);
    return this.getState();
  }
}
