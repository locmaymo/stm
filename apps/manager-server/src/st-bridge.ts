import { randomUUID } from 'node:crypto';
import { BRIDGE_REFRESH, BRIDGE_SLASH_COMMANDS, BRIDGE_SLASH_MAX, type BridgeCommand, type BridgeCommandState, type BridgeCommandStatus, type BridgeResult } from '../../../packages/contracts/src/index.js';

/**
 * The manager asking an open SillyTavern tab to do something.
 *
 * Some of SillyTavern's state lives in the tab: the active connection profile,
 * API, model, key and theme are held in the page's memory, and the page saves
 * `settings.json` whole, so a change made to that file while a tab is open is
 * written over. The only way to change them then is through the tab.
 *
 * The door adds one script to every SillyTavern page it serves (like the
 * reply script). Once SillyTavern has finished loading, the page opens a
 * stream of server-sent events to the door and says which tab it is, whether
 * it is being looked at and which version it runs. The manager puts a command
 * in the queue here; the most recently looked-at tab gets it, runs it, and
 * posts the result back. A page whose stream cannot stay open asks every ten
 * seconds instead.
 *
 * Only what `parseBridgeCommand` accepts is ever queued, and the page checks
 * the same list again before running anything. A command no tab takes within
 * ten minutes expires, and so does one a tab took and never answered.
 *
 * A page opened on SillyTavern's own port, past the door, has no script and so
 * no bridge.
 */

export const BRIDGE_SCRIPT_PATH = '/__stm/bridge.js';
export const BRIDGE_PREFIX = '/__stm/bridge/';
export const BRIDGE_TAG = `<script src="${BRIDGE_SCRIPT_PATH}" defer></script>`;

/** How long a command waits for a tab, and then for its answer. */
export const BRIDGE_EXPIRY_MS = 10 * 60 * 1000;
/** How often a page without a stream asks for commands. */
export const BRIDGE_POLL_MS = 10_000;
/** How long a tab with no stream still counts as open after it last asked. */
const TAB_GRACE_MS = 3 * BRIDGE_POLL_MS;
/** How long an answered or expired command can still be asked about. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;
/** More than this many commands waiting at once is a caller gone wrong. */
const MAX_WAITING = 100;

/** A command as a tab receives it. */
export interface BridgeDelivery {
  readonly id: string;
  readonly command: BridgeCommand;
}

/** What a tab says about itself. */
export interface BridgeTabReport {
  readonly visible: boolean;
  readonly stVersion: string;
}

interface Tab {
  visible: boolean;
  stVersion: string;
  seenAt: number;
  /** When it last said it was being looked at; 0 for never. */
  visibleAt: number;
  /** The open stream, if it has one. */
  sink: ((delivery: BridgeDelivery) => void) | null;
}

interface Entry {
  readonly id: string;
  readonly command: BridgeCommand;
  readonly createdAt: number;
  state: BridgeCommandState;
  tab: string | null;
  result: BridgeResult | null;
  finishedAt: number;
}

export interface SillyTavernBridgeOptions {
  readonly now?: () => number;
  readonly expiryMs?: number;
}

export class BridgeBusyError extends Error {
  public readonly code = 'bridge_busy';
}

export class SillyTavernBridge {
  private readonly now: () => number;
  private readonly expiryMs: number;
  private readonly tabs = new Map<string, Tab>();
  /** In the order they were asked for, so they run in that order too. */
  private readonly entries = new Map<string, Entry>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly timer: NodeJS.Timeout;

  public constructor(options: SillyTavernBridgeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.expiryMs = options.expiryMs ?? BRIDGE_EXPIRY_MS;
    this.timer = setInterval(() => this.sweep(), 5_000);
    this.timer.unref();
  }

  public close(): void {
    clearInterval(this.timer);
    for (const tab of this.tabs.values()) tab.sink = null;
    this.tabs.clear();
  }

  /** How many tabs are open, and whether any of them is being looked at. */
  public summary(): { readonly tabs: number; readonly visible: boolean } {
    this.sweep();
    return { tabs: this.tabs.size, visible: [...this.tabs.values()].some((tab) => tab.visible) };
  }

  /**
   * A tab's stream opened. Returns what to call when it closes.
   *
   * The same tab reconnecting replaces its old stream; commands it held when
   * the old one dropped are sent again on the new one.
   */
  public connect(tabId: string, report: BridgeTabReport, sink: (delivery: BridgeDelivery) => void): () => void {
    const tab = this.touch(tabId, report);
    tab.sink = sink;
    for (const entry of this.entries.values()) {
      if (entry.state === 'delivered' && entry.tab === tabId) sink({ id: entry.id, command: entry.command });
    }
    this.flush();
    return () => {
      if (tab.sink !== sink) return;
      tab.sink = null;
      // Gone for good unless it comes back before the grace runs out; then
      // what it held goes to whichever tab is left.
      tab.seenAt = this.now();
    };
  }

  /**
   * A tab saying where it is. A tab without a stream also collects its
   * commands this way, so they are what this returns.
   */
  public report(tabId: string, report: BridgeTabReport): BridgeDelivery[] {
    const tab = this.touch(tabId, report);
    this.flush();
    if (tab.sink) return [];
    const target = this.target();
    const out: BridgeDelivery[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === 'delivered' && entry.tab === tabId) out.push({ id: entry.id, command: entry.command });
      else if (entry.state === 'waiting' && target === tabId) {
        entry.state = 'delivered';
        entry.tab = tabId;
        out.push({ id: entry.id, command: entry.command });
        this.changed(entry.id);
      }
    }
    return out;
  }

  /** A tab's answer. Only the tab that was given the command can answer it. */
  public result(tabId: string, id: string, result: BridgeResult): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'delivered' || entry.tab !== tabId) return false;
    entry.state = 'done';
    entry.result = result;
    entry.finishedAt = this.now();
    this.changed(id);
    return true;
  }

  /** Queue a command; it goes to a tab at once when one is open. */
  public send(command: BridgeCommand): BridgeCommandStatus {
    this.sweep();
    let waiting = 0;
    for (const entry of this.entries.values()) if (entry.state === 'waiting' || entry.state === 'delivered') waiting += 1;
    if (waiting >= MAX_WAITING) throw new BridgeBusyError('Too many commands are already waiting for SillyTavern');
    const entry: Entry = { id: randomUUID(), command, createdAt: this.now(), state: 'waiting', tab: null, result: null, finishedAt: 0 };
    this.entries.set(entry.id, entry);
    this.flush();
    return this.describe(entry);
  }

  public status(id: string): BridgeCommandStatus | null {
    this.sweep();
    const entry = this.entries.get(id);
    return entry ? this.describe(entry) : null;
  }

  /**
   * The command's status once it has an answer or has expired, or once the
   * time is up, whichever is first; null when there is no such command.
   */
  public async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<BridgeCommandStatus | null> {
    const first = this.status(id);
    if (!first || first.state === 'done' || first.state === 'expired' || timeoutMs <= 0) return first;
    await new Promise<void>((resolve) => {
      let set = this.watchers.get(id);
      if (!set) { set = new Set(); this.watchers.set(id, set); }
      const watchers = set;
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        watchers.delete(check);
        if (watchers.size === 0) this.watchers.delete(id);
        resolve();
      };
      const check = (): void => {
        const entry = this.entries.get(id);
        if (!entry || entry.state === 'done' || entry.state === 'expired') finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      watchers.add(check);
      signal?.addEventListener('abort', finish, { once: true });
    });
    return this.status(id);
  }

  private touch(tabId: string, report: BridgeTabReport): Tab {
    const now = this.now();
    let tab = this.tabs.get(tabId);
    if (!tab) { tab = { visible: false, stVersion: '', seenAt: now, visibleAt: 0, sink: null }; this.tabs.set(tabId, tab); }
    tab.visible = report.visible;
    tab.stVersion = report.stVersion;
    tab.seenAt = now;
    if (report.visible) tab.visibleAt = now;
    return tab;
  }

  /**
   * The tab a command goes to: the one looked at most recently, and among
   * tabs nobody has looked at, the one heard from last.
   */
  private target(): string | null {
    let best: string | null = null;
    let bestTab: Tab | null = null;
    for (const [id, tab] of this.tabs) {
      if (!bestTab || tab.visibleAt > bestTab.visibleAt || (tab.visibleAt === bestTab.visibleAt && tab.seenAt > bestTab.seenAt)) {
        best = id;
        bestTab = tab;
      }
    }
    return best;
  }

  /** Every waiting command, to the target tab if it has a stream to send it on. */
  private flush(): void {
    const target = this.target();
    const tab = target ? this.tabs.get(target) : undefined;
    if (!target || !tab?.sink) return;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'waiting') continue;
      entry.state = 'delivered';
      entry.tab = target;
      tab.sink({ id: entry.id, command: entry.command });
      this.changed(entry.id);
    }
  }

  /**
   * Tabs that have gone, commands that waited too long, and answers nobody
   * asked about.
   */
  private sweep(): void {
    const now = this.now();
    let dropped = false;
    for (const [id, tab] of this.tabs) {
      if (tab.sink || now - tab.seenAt < TAB_GRACE_MS) continue;
      this.tabs.delete(id);
      dropped = true;
      // What it was given and never answered goes back to the queue.
      for (const entry of this.entries.values()) {
        if (entry.state === 'delivered' && entry.tab === id) { entry.state = 'waiting'; entry.tab = null; }
      }
    }
    for (const entry of this.entries.values()) {
      if ((entry.state === 'waiting' || entry.state === 'delivered') && now - entry.createdAt >= this.expiryMs) {
        entry.state = 'expired';
        entry.result = { ok: false, error: 'expired' };
        entry.finishedAt = now;
        this.changed(entry.id);
      } else if ((entry.state === 'done' || entry.state === 'expired') && now - entry.finishedAt >= KEEP_FINISHED_MS) {
        this.entries.delete(entry.id);
        this.changed(entry.id);
      }
    }
    if (dropped) this.flush();
  }

  private changed(id: string): void {
    for (const check of [...(this.watchers.get(id) ?? [])]) check();
  }

  private describe(entry: Entry): BridgeCommandStatus {
    return { id: entry.id, state: entry.state, result: entry.result, tabs: this.tabs.size };
  }
}

/** A tab's id as the page makes it; anything else is not a tab. */
export function isTabId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{8,64}$/u.test(value);
}

/** A result as a page posts it, made safe to keep; null when it is not one. */
export function parseBridgeResult(value: unknown): { readonly tab: string; readonly id: string; readonly result: BridgeResult } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isTabId(record.tab) || typeof record.id !== 'string' || record.id.length > 64 || typeof record.ok !== 'boolean') return null;
  const result: BridgeResult = record.ok
    ? { ok: true, value: typeof record.value === 'string' ? record.value.slice(0, 1000) : '' }
    : { ok: false, error: typeof record.error === 'string' && record.error !== '' ? record.error.slice(0, 300) : 'failed' };
  return { tab: record.tab, id: record.id, result };
}

/**
 * The page script.
 *
 * Plain ES5-ish JavaScript with no template literals, so it can sit inside
 * this file's own template string like the reply script. It does nothing until
 * SillyTavern says it has started (both events below are fired again for a
 * listener that comes late), so a command never reaches a page that cannot run
 * it yet - including a fresh install still asking its first-run questions,
 * which hold the start until they are answered.
 */
export const BRIDGE_SCRIPT = `(function(){
'use strict';
if(window.__stmBridge)return;
window.__stmBridge=true;
var SLASH=${JSON.stringify(BRIDGE_SLASH_COMMANDS)},REFRESH=${JSON.stringify(BRIDGE_REFRESH)},MAX=${BRIDGE_SLASH_MAX},POLL=${BRIDGE_POLL_MS},QUIET=70000;
var TAB=(Math.random().toString(36).slice(2)+Date.now().toString(36)).replace(/[^a-z0-9]/g,'').slice(0,24);
var version='',source=null,polling=false,heard=0,watch=0;
function shown(){return document.visibilityState==='visible'}
function post(path,body){return fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-stm-tools':'1'},body:JSON.stringify(body)})}
function context(){var t=window.SillyTavern;return t&&typeof t.getContext==='function'?t.getContext():null}
/* The same list the manager checks, checked again here: one command, from the
   list, with nothing that would chain a second one on. */
function allowed(text){if(typeof text!=='string'||text.length>MAX||/[|\\r\\n]|\\{\\{|\\{:|:\\}/.test(text))return false;var m=/^\\/([a-z][a-z0-9-]*)(?=\\s|$)/i.exec(text);return!!m&&SLASH.indexOf(m[1].toLowerCase())!==-1}
function perform(c){var ctx=context();if(!ctx)throw new Error('not_ready');
if(c&&c.kind==='slash'){if(!allowed(c.command))throw new Error('not_allowed');if(typeof ctx.executeSlashCommandsWithOptions!=='function')throw new Error('unsupported');
return ctx.executeSlashCommandsWithOptions(c.command,{handleParserErrors:false,handleExecutionErrors:false,source:'stm'}).then(function(r){if(r&&r.isError)throw new Error(r.errorMessage||'failed');if(r&&r.isAborted)throw new Error(r.abortReason||'aborted');return r&&r.pipe!=null?r.pipe:''})}
if(c&&c.kind==='refresh'&&REFRESH.indexOf(c.what)!==-1){var f=c.what==='characters'?ctx.getCharacters:ctx.updateWorldInfoList;if(typeof f!=='function')throw new Error('unsupported');return Promise.resolve(f()).then(function(){return''})}
throw new Error('not_allowed')}
/* A command is run once. Sent again - its answer was lost with the stream -
   it gets the same answer again rather than a second run. */
var done={};
function answer(r){post('${BRIDGE_PREFIX}result',r).catch(function(){})}
function run(d){if(!d||typeof d.id!=='string')return;if(Object.prototype.hasOwnProperty.call(done,d.id)){if(done[d.id])answer(done[d.id]);return}done[d.id]=null;var p;try{p=Promise.resolve(perform(d.command))}catch(e){p=Promise.reject(e)}
p.then(function(v){return{tab:TAB,id:d.id,ok:true,value:String(v).slice(0,1000)}},function(e){return{tab:TAB,id:d.id,ok:false,error:String(e&&e.message||e||'failed').slice(0,300)}}).then(function(r){done[d.id]=r;answer(r)})}
function report(){return post('${BRIDGE_PREFIX}state',{tab:TAB,visible:shown(),stVersion:version}).then(function(r){if(r.status===401){polling=false;return null}return r.ok?r.json():null}).then(function(b){if(b&&b.commands)b.commands.forEach(run)}).catch(function(){})}
function poll(){if(!polling)return;report().then(function(){if(polling)setTimeout(poll,POLL)})}
function fallback(){if(source){source.close();source=null}clearInterval(watch);if(polling)return;polling=true;poll()}
/* A stream a proxy holds back looks open and says nothing; the door says
   something every twenty-five seconds, so a long silence means it is time
   to ask instead. */
function connect(){if(!window.EventSource){fallback();return}
source=new EventSource('${BRIDGE_PREFIX}events?tab='+TAB+'&visible='+(shown()?1:0)+'&v='+encodeURIComponent(version));heard=Date.now();
source.addEventListener('ping',function(){heard=Date.now()});
source.addEventListener('command',function(e){heard=Date.now();try{run(JSON.parse(e.data))}catch(x){}});
source.onerror=function(){if(source&&source.readyState===2)fallback()};
watch=setInterval(function(){if(Date.now()-heard>QUIET)fallback()},10000)}
/* Said only once SillyTavern is ready: a page still starting - or held by its
   first-run questions - is not a tab that can take a command. */
var started=false;
document.addEventListener('visibilitychange',function(){if(started)report()});
function start(){if(started)return;started=true;fetch('/version',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{}}).then(function(v){version=String(v&&v.pkgVersion||'')},function(){}).then(connect)}
/* Ready is the first of APP_INITIALIZED (every command and list is set up)
   and APP_READY, which also waits for the splash screen's animation - and a
   tab opened in the background may not play that until it is looked at. */
var tries=0,timer=setInterval(function(){var ctx=context();var ev=ctx&&ctx.eventTypes;if(ctx&&ctx.eventSource&&ev&&(ev.APP_INITIALIZED||ev.APP_READY)){clearInterval(timer);if(ev.APP_INITIALIZED)ctx.eventSource.on(ev.APP_INITIALIZED,start);if(ev.APP_READY)ctx.eventSource.on(ev.APP_READY,start)}else if(++tries>=120)clearInterval(timer)},1000);
})();`;
