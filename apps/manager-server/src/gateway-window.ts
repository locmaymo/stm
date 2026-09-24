import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import { formatLogMessage, translateLogEntry, translateStep, type Job, type LogEntry, type LogPage } from '../../../packages/contracts/src/index.js';

/**
 * SillyTavern in a tab of its own, with the manager's tools laid over it.
 *
 * The console can already show SillyTavern in a window with a bar and a
 * floating button, but only from the machine the manager runs on: anywhere
 * else the console and the door are two different sites, and the door's
 * session cookie inside the console's frame is a third-party cookie that
 * Safari and Firefox refuse outright. This page is served by the door itself,
 * so the frame in it is the same site as the page around it - the cookie is
 * first-party, and it works through the tunnel and on a phone the same as it
 * does here.
 *
 * It is plain HTML and one inline script, like the sign-in page, because the
 * door is served without the console's bundle. The look follows the console's
 * own window: three lights, a title, and a floating button that can be
 * dragged to either edge.
 */

export type WindowLocale = 'en' | 'vi';

interface WindowText {
  readonly lang: WindowLocale;
  readonly title: string;
  readonly close: string;
  readonly hideBar: string;
  readonly showBar: string;
  readonly fullscreen: string;
  readonly controls: string;
  readonly backupLocal: string;
  readonly backupCloud: string;
  readonly logs: string;
  readonly reload: string;
  readonly signOut: string;
  readonly signOutConfirm: string;
  readonly plain: string;
  readonly started: string;
  readonly done: string;
  readonly unchanged: string;
  readonly failed: string;
  readonly logsEmpty: string;
  readonly logsRefresh: string;
  readonly logsClose: string;
  readonly compact: string;
  readonly detailed: string;
  readonly maximize: string;
  readonly restore: string;
  readonly resize: string;
  readonly search: string;
  readonly noMatches: string;
  readonly source: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly busy: string;
  readonly refusals: Readonly<Record<string, string>>;
}

const TEXT: Readonly<Record<WindowLocale, WindowText>> = {
  en: {
    lang: 'en',
    title: 'SillyTavern',
    close: 'Close',
    hideBar: 'Hide the bar',
    showBar: 'Show the bar',
    fullscreen: 'Full screen',
    controls: 'SillyTavern Manager tools',
    backupLocal: 'Back up on this machine now',
    backupCloud: 'Back up to the cloud now',
    logs: 'Logs',
    reload: 'Reload SillyTavern',
    signOut: 'Sign this device out',
    signOutConfirm: 'Sign this device out? The PIN will be asked for again next time.',
    plain: 'Open without tools',
    started: 'Backing up…',
    done: 'Backup finished',
    unchanged: 'Nothing has changed since the last backup',
    failed: 'The backup did not finish',
    logsEmpty: 'Nothing logged yet.',
    logsRefresh: 'Refresh',
    logsClose: 'Close',
    compact: 'Compact view',
    detailed: 'Detailed view',
    maximize: 'Fill the screen',
    restore: 'Back to its size',
    resize: 'Drag to resize',
    search: 'Search the log',
    noMatches: 'No lines match.',
    source: 'Log source',
    sources: { all: 'All logs', sillytavern: 'SillyTavern', manager: 'Manager', cloudflared: 'Cloudflare Tunnel', installer: 'Installer', backup: 'Backups' },
    busy: 'Another task is running. Try again when it finishes.',
    refusals: {
      saver_mode: 'Saver mode is on, so nothing is backed up on this machine.',
      profile_required: 'There is no data profile to back up yet.',
      r2_not_configured: 'The cloud is not connected yet. Connect it in SillyTavern Manager.',
    },
  },
  vi: {
    lang: 'vi',
    title: 'SillyTavern',
    close: 'Đóng',
    hideBar: 'Ẩn thanh công cụ',
    showBar: 'Hiện thanh công cụ',
    fullscreen: 'Toàn màn hình',
    controls: 'Tiện ích của SillyTavern Manager',
    backupLocal: 'Sao lưu cục bộ ngay',
    backupCloud: 'Sao lưu lên cloud ngay',
    logs: 'Xem logs',
    reload: 'Tải lại SillyTavern',
    signOut: 'Đăng xuất thiết bị này',
    signOutConfirm: 'Đăng xuất thiết bị này? Lần sau sẽ phải nhập lại mã PIN.',
    plain: 'Mở không kèm tiện ích',
    started: 'Đang sao lưu…',
    done: 'Sao lưu xong',
    unchanged: 'Không có gì thay đổi kể từ bản sao lưu gần nhất',
    failed: 'Sao lưu không hoàn tất',
    logsEmpty: 'Chưa có dòng nào.',
    logsRefresh: 'Làm mới',
    logsClose: 'Đóng',
    compact: 'Hiển thị gọn',
    detailed: 'Hiển thị chi tiết',
    maximize: 'Phóng to toàn màn hình',
    restore: 'Thu về kích thước cũ',
    resize: 'Kéo để đổi kích thước',
    search: 'Tìm trong log',
    noMatches: 'Không có dòng nào khớp.',
    source: 'Nguồn log',
    sources: { all: 'Tất cả log', sillytavern: 'SillyTavern', manager: 'Manager', cloudflared: 'Cloudflare Tunnel', installer: 'Trình cài đặt', backup: 'Sao lưu' },
    busy: 'Đang có một tác vụ khác chạy. Thử lại khi nó xong nhé.',
    refusals: {
      saver_mode: 'Đang bật chế độ tiết kiệm nên không sao lưu trên máy này.',
      profile_required: 'Chưa có hồ sơ dữ liệu nào để sao lưu.',
      r2_not_configured: 'Chưa kết nối đám mây. Hãy kết nối trong SillyTavern Manager.',
    },
  },
};

const CATALOG: Readonly<Record<WindowLocale, Record<string, unknown>>> = {
  en: (en as { logs: Record<string, unknown> }).logs,
  vi: (vi as { logs: Record<string, unknown> }).logs,
};

/** One log line as the window shows it: already in the reader's language. */
export interface WindowLogLine {
  readonly id: number;
  readonly time: string;
  readonly source: LogEntry['source'];
  readonly level: LogEntry['level'];
  readonly text: string;
  /** The English the server wrote, so a search in either language finds the line. */
  readonly english: string;
}

export function windowLogs(page: LogPage, locale: WindowLocale): { readonly lines: readonly WindowLogLine[]; readonly next: number } {
  return {
    lines: page.entries.map((entry) => ({ id: entry.id, time: entry.timestamp, source: entry.source, level: entry.level, text: translateLogEntry(entry, CATALOG[locale]), english: formatLogMessage(entry.message) })),
    next: page.nextCursor,
  };
}

/** A job as the window follows it: where it is and, at the end, how it went. */
export function windowJob(job: Job, locale: WindowLocale): { readonly state: Job['state']; readonly progress: number; readonly step: string; readonly error: string | null } {
  return { state: job.state, progress: job.progress, step: translateStep(job.step, CATALOG[locale], job.stepCode, job.stepParams), error: job.error ?? null };
}

const ICONS = {
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  minus: '<path d="M5 12h14"/>',
  maximize: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  cloud: '<path d="M12 13v8"/><path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="m8 17 4-4 4 4"/>',
  logs: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.8 1 6.5 2.7L21 8"/><path d="M21 3v5h-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  out: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  funnel: '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
  rows: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/>',
  shrink: '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
} as const;

function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

/** JSON for a `<script type="application/json">`, which must not be able to close its own tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

export function windowPage(locale: WindowLocale, nonce: string): string {
  const text = TEXT[locale];
  const e = escapeHtml;
  const item = (act: string, name: keyof typeof ICONS, label: string, extra = '') => `<button type="button" role="menuitem" data-act="${act}"${extra}>${icon(name)}<span>${e(label)}</span></button>`;
  return `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>${e(text.title)}</title>
<style>${WINDOW_STYLE}</style>
</head>
<body data-bar="on">
<header class="bar" id="bar">
<div class="lights" role="group" aria-label="${e(text.controls)}">
<button type="button" class="light close" data-act="close" aria-label="${e(text.close)}" title="${e(text.close)}">${icon('x')}</button>
<button type="button" class="light min" data-act="hidebar" aria-label="${e(text.hideBar)}" title="${e(text.hideBar)}">${icon('minus')}</button>
<button type="button" class="light zoom" data-act="fullscreen" aria-label="${e(text.fullscreen)}" title="${e(text.fullscreen)}">${icon('maximize')}</button>
</div>
<span class="title">${e(text.title)}</span>
<div class="end"><a class="bar-link" href="/" title="${e(text.plain)}">${icon('out')}<span>${e(text.plain)}</span></a></div>
</header>
<iframe id="frame" class="frame" src="/" title="SillyTavern" allow="clipboard-write; fullscreen; microphone"></iframe>
<div class="scrim" id="scrim" hidden></div>
<button type="button" class="handle" id="handle" aria-label="${e(text.controls)}" aria-expanded="false" aria-controls="menu"><span></span></button>
<div class="menu" id="menu" role="menu" hidden>
${item('togglebar', 'panel', text.hideBar)}
<span class="rule" aria-hidden="true"></span>
${item('backup-local', 'archive', text.backupLocal)}
${item('backup-cloud', 'cloud', text.backupCloud)}
${item('logs', 'logs', text.logs)}
${item('reload', 'reload', text.reload)}
${item('plain', 'out', text.plain)}
<span class="rule" aria-hidden="true"></span>
${item('signout', 'logout', text.signOut, ' class="danger"')}
${item('close', 'x', text.close, ' class="danger"')}
</div>
<section class="logs" id="logs" role="dialog" aria-label="${e(text.logs)}" hidden>
<span class="grip" data-resize="top" role="separator" aria-orientation="horizontal" aria-label="${e(text.resize)}" title="${e(text.resize)}"><i></i></span><span class="edge-left" data-resize="left" aria-hidden="true"></span><span class="corner" data-resize="both" aria-hidden="true"></span>
<header><strong>${e(text.logs)}</strong><button type="button" data-act="logs-search" id="searchbtn" aria-pressed="false" aria-label="${e(text.search)}" title="${e(text.search)}">${icon('search')}</button><button type="button" data-act="logs-filter" id="filterbtn" aria-pressed="false" aria-label="${e(text.source)}" title="${e(text.source)}">${icon('funnel')}</button><button type="button" data-act="logs-density" aria-pressed="false">${icon('rows')}<span id="density"></span></button><button type="button" data-act="logs-refresh" aria-label="${e(text.logsRefresh)}" title="${e(text.logsRefresh)}">${icon('reload')}</button><button type="button" data-act="logs-max" id="logsmax" aria-label="${e(text.maximize)}" title="${e(text.maximize)}">${icon('maximize')}${icon('shrink')}</button><button type="button" data-act="logs-close" aria-label="${e(text.logsClose)}" title="${e(text.logsClose)}">${icon('x')}</button></header>
<div class="filter" id="filter" role="radiogroup" aria-label="${e(text.source)}" hidden>${Object.entries(text.sources).map(([id, label]) => `<button type="button" role="radio" data-source="${id}" aria-checked="${id === 'all' ? 'true' : 'false'}">${e(label)}</button>`).join('')}</div>
<div class="search" id="search" hidden>${icon('search')}<input id="query" type="search" placeholder="${e(text.search)}" aria-label="${e(text.search)}"></div>
<p class="nomatch" id="nomatch" hidden>${e(text.noMatches)}</p>
<div class="lines" id="lines"><p class="empty">${e(text.logsEmpty)}</p></div>
</section>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script type="application/json" id="stm-text">${scriptJson({ ...text })}</script>
<script nonce="${nonce}">${WINDOW_SCRIPT}</script>
</body>
</html>`;
}

const WINDOW_STYLE = `*{box-sizing:border-box}[hidden]{display:none!important}:root{color-scheme:light;--bg:#f7f8fb;--card:#fff;--line:#e3e7ef;--ink:#0f172a;--muted:#5a6b82;--accent:#eef2f8;--danger:#dc2626;--ok:#067647;--brand:#2563eb;--shadow:0 18px 40px -18px rgba(15,23,42,.35)}@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b0f16;--card:#111827;--line:#1f2937;--ink:#e5e9f0;--muted:#94a3b8;--accent:#1c2533;--danger:#f87171;--ok:#4ade80;--brand:#60a5fa;--shadow:0 18px 40px -18px rgba(0,0,0,.8)}}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,"Segoe UI",Roboto,"Noto Sans",sans-serif;overflow:hidden}button{font:inherit;color:inherit;cursor:pointer}.bar{display:flex;flex-shrink:0;align-items:center;gap:12px;height:44px;padding:env(safe-area-inset-top) 12px 0;box-sizing:content-box;border-bottom:1px solid var(--line);background:var(--card)}body[data-bar=off] .bar{display:none}.lights,.end{display:flex;flex:1 1 0;min-width:fit-content;align-items:center}.lights{gap:8px}.end{justify-content:flex-end}.light{position:relative;display:grid;place-items:center;width:14px;height:14px;padding:0;border:0;border-radius:999px;color:rgba(0,0,0,.6);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.2)}.light:after{content:"";position:absolute;inset:-9px -5px}.light svg{width:10px;height:10px;stroke-width:3;opacity:0;transition:opacity .1s}.lights:hover .light svg,.light:focus-visible svg{opacity:1}.close{background:#ff5f57}.min{background:#febc2e}.zoom{background:#28c840}@media (pointer:coarse){.lights{gap:16px}.light{width:20px;height:20px}.light svg{width:12px;height:12px;opacity:1}}.title{flex:0 1 auto;min-width:0;overflow:hidden;color:var(--muted);font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.bar-link{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border-radius:6px;color:var(--muted);font-size:12.5px;font-weight:500;text-decoration:none}.bar-link:hover,.bar-link:focus-visible{background:var(--accent);color:var(--ink)}.bar-link svg{width:14px;height:14px}@media (max-width:480px){.bar-link span{display:none}}.frame{flex:1;width:100%;min-height:0;border:0;background:var(--bg)}body[data-dragging] .frame{pointer-events:none}.scrim{position:fixed;inset:0;z-index:2}.handle{position:fixed;z-index:3;display:grid;place-items:center;width:48px;height:48px;padding:0;border:0;border-radius:14px;background:rgba(20,22,28,.72);box-shadow:0 6px 18px rgba(0,0,0,.35);opacity:.5;touch-action:none;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:opacity .15s,left .24s cubic-bezier(.22,1,.36,1),top .24s cubic-bezier(.22,1,.36,1);cursor:grab}.handle span{width:24px;height:24px;border-radius:999px;background:rgba(255,255,255,.85);box-shadow:0 0 0 5px rgba(255,255,255,.22)}.handle:hover,.handle:focus-visible,.handle[data-active]{opacity:1}.handle[data-active]{transition:opacity .15s;cursor:grabbing}.handle[data-busy] span{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{transform:scale(.7)}}.menu{position:fixed;z-index:3;display:grid;min-width:13rem;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow)}.menu button{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 10px;border:0;border-radius:8px;background:transparent;font-size:13.5px;text-align:left}.menu button:hover,.menu button:focus-visible{background:var(--accent)}.menu button:disabled{opacity:.5;cursor:default}.menu svg{flex-shrink:0;width:16px;height:16px;color:var(--muted)}.menu .danger,.menu .danger svg{color:var(--danger)}.menu .rule{height:1px;margin:4px 6px;background:var(--line)}.logs{position:fixed;z-index:1;right:12px;bottom:12px;display:flex;flex-direction:column;width:min(var(--logs-width,40rem),calc(100vw - 16px));height:min(var(--logs-height,26rem),calc(100dvh - 16px));border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}.logs[data-max]{inset:0;width:auto;height:auto;border-radius:0}.logs[data-max] .grip,.logs[data-max] .edge-left,.logs[data-max] .corner{display:none}.logs header{display:flex;align-items:center;gap:4px;padding:10px 8px 8px 14px;border-bottom:1px solid var(--line)}.logs header strong{flex:1;font-size:14px}.logs header button{display:inline-flex;white-space:nowrap;align-items:center;gap:6px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size:12.5px}.logs header button:hover{background:var(--accent);color:var(--ink)}.logs header svg{width:15px;height:15px}#logsmax svg+svg,.logs[data-max] #logsmax svg:first-child{display:none}.logs[data-max] #logsmax svg+svg{display:block}.grip{position:absolute;top:0;left:0;right:0;z-index:1;display:grid;height:10px;place-items:center;cursor:ns-resize;touch-action:none}.grip i{width:36px;height:4px;margin-top:3px;border-radius:999px;background:color-mix(in srgb,var(--muted) 45%,transparent)}.edge-left{position:absolute;top:0;bottom:0;left:0;z-index:1;width:6px;cursor:ew-resize;touch-action:none}.corner{position:absolute;top:0;left:0;z-index:2;width:14px;height:14px;cursor:nwse-resize;touch-action:none}:root[data-resizing]{user-select:none}:root[data-resizing] .frame{pointer-events:none}.search{position:relative;display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line)}.search svg{position:absolute;left:22px;width:15px;height:15px;color:var(--muted)}.search input{width:100%;height:34px;padding:0 10px 0 32px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:16px;outline:none}@media (min-width:641px){.search input{font-size:13px}}.filter{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--line)}.filter button{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font-size:12.5px}.filter button:hover{color:var(--ink)}.filter button[aria-checked=true]{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 10%,transparent);color:var(--brand)}.logs header button[aria-pressed=true] svg{color:var(--brand)}.nomatch{margin:0;padding:8px 12px;color:var(--muted);font-size:12.5px}.lines p[data-miss]{display:none}.lines{flex:1;overflow:auto;padding:8px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.lines p{margin:0;padding:2px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);white-space:pre-wrap;word-break:break-word}.lines time{margin-right:8px;color:var(--muted)}.lines .src{margin-right:6px;color:var(--brand)}.logs[data-compact] .lines time,.logs[data-compact] .lines .src{display:none}.lines .warn{color:#b45309}.lines .error{color:var(--danger)}.lines .empty{border:0;color:var(--muted);font-family:system-ui,sans-serif}@media (max-width:640px){.logs:not([data-max]){right:8px;left:8px;bottom:8px;width:auto;height:min(var(--logs-height,70dvh),calc(100dvh - 16px))}.edge-left,.corner{display:none}.grip{height:18px}.logs header button span{display:none}}body[data-zoom] .bar{display:none}.toast{position:fixed;z-index:5;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow);font-size:13.5px}.toast[data-tone=ok]{border-color:color-mix(in srgb,var(--ok) 45%,var(--line));color:var(--ok)}.toast[data-tone=bad]{border-color:color-mix(in srgb,var(--danger) 45%,var(--line));color:var(--danger)}@media (prefers-reduced-motion:reduce){.handle{transition:opacity .15s}.handle[data-busy] span{animation:none}}`;

/*
 * The script, as plain ES5-ish JavaScript with no template literals so it can
 * sit inside this file's own template string.
 */
const WINDOW_SCRIPT = `(function(){
var T=JSON.parse(document.getElementById('stm-text').textContent);
var root=document.documentElement,body=document.body,frame=document.getElementById('frame'),handle=document.getElementById('handle'),menu=document.getElementById('menu'),scrim=document.getElementById('scrim'),logs=document.getElementById('logs'),lines=document.getElementById('lines'),toast=document.getElementById('toast'),density=document.getElementById('density'),logsMax=document.getElementById('logsmax');
var SIZE=48,GAP=10,SLOP=6,KEY='stm-window-handle',BAR='stm-window-bar',LSIZE='stm-tools-logs-size',LCOMPACT='stm-tools-logs-compact';
function store(k,v){try{if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){}}
function load(k){try{return localStorage.getItem(k)}catch(e){return null}}
function clamp(t){return typeof t==='number'&&isFinite(t)?Math.min(.92,Math.max(.08,t)):.42}
var place=(function(){try{var p=JSON.parse(load(KEY)||'null');if(p&&(p.side==='left'||p.side==='right'))return{side:p.side,top:clamp(p.top)}}catch(e){}return{side:'right',top:.42}})();
function rest(){var w=innerWidth,h=innerHeight;handle.style.left=(place.side==='left'?GAP:Math.max(GAP,w-SIZE-GAP))+'px';handle.style.top=Math.max(0,clamp(place.top)*h-SIZE/2)+'px'}
function barShown(){return body.getAttribute('data-bar')==='on'&&!body.hasAttribute('data-zoom')}
function label(){var b=menu.querySelector('[data-act=togglebar] span');if(b)b.textContent=barShown()?T.hideBar:T.showBar}
function setBar(on){body.setAttribute('data-bar',on?'on':'off');store(BAR,on?null:'off');label()}
/* The green light: the whole screen, bar and all, the way the console's own
   window does it. Leaving full screen brings the bar back. */
var wentFull=false;
function zoom(){body.setAttribute('data-zoom','');label();var d=root;if(d.requestFullscreen&&!document.fullscreenElement){wentFull=true;d.requestFullscreen().catch(function(){wentFull=false})}}
function unzoom(){body.removeAttribute('data-zoom');label();if(wentFull&&document.fullscreenElement)document.exitFullscreen().catch(function(){});wentFull=false}
document.addEventListener('fullscreenchange',function(){if(!document.fullscreenElement&&wentFull){wentFull=false;body.removeAttribute('data-zoom');label()}});
setBar(load(BAR)!=='off');rest();addEventListener('resize',function(){rest();if(!menu.hidden)placeMenu()});
function placeMenu(){var h=innerHeight,mh=menu.offsetHeight||300,top=clamp(place.top)*h-SIZE/2;menu.style.top=Math.max(8,Math.min(top,h-mh-8))+'px';menu.style.left='';menu.style.right='';menu.style[place.side]=(SIZE+GAP+8)+'px'}
function openMenu(open){menu.hidden=!open;scrim.hidden=!open;handle.setAttribute('aria-expanded',open?'true':'false');if(open){handle.setAttribute('data-active','');placeMenu();var f=menu.querySelector('button');if(f&&matchMedia('(pointer: fine)').matches)f.focus()}else handle.removeAttribute('data-active')}
var press=null;
handle.addEventListener('pointerdown',function(e){handle.setPointerCapture(e.pointerId);press={x:e.clientX,y:e.clientY,moved:false}});
handle.addEventListener('pointermove',function(e){if(!press)return;if(!press.moved&&Math.hypot(e.clientX-press.x,e.clientY-press.y)<SLOP)return;if(!press.moved){press.moved=true;openMenu(false);handle.setAttribute('data-active','');body.setAttribute('data-dragging','')}var hf=SIZE/2;handle.style.left=(Math.min(innerWidth-hf,Math.max(hf,e.clientX))-hf)+'px';handle.style.top=(Math.min(innerHeight-hf,Math.max(hf,e.clientY))-hf)+'px'});
handle.addEventListener('pointerup',function(e){var p=press;press=null;if(!p)return;if(!p.moved){openMenu(menu.hidden);return}place={side:e.clientX<innerWidth/2?'left':'right',top:clamp(e.clientY/innerHeight)};store(KEY,JSON.stringify(place));handle.removeAttribute('data-active');body.removeAttribute('data-dragging');rest()});
handle.addEventListener('pointercancel',function(){press=null;handle.removeAttribute('data-active');body.removeAttribute('data-dragging');rest()});
handle.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openMenu(menu.hidden)}});
scrim.addEventListener('click',function(){openMenu(false)});
addEventListener('keydown',function(e){if(e.key!=='Escape')return;if(!menu.hidden)openMenu(false);else if(!logs.hidden)closeLogs()});
var hideTimer=0;
function say(msg,tone,stay){toast.textContent=msg;toast.setAttribute('data-tone',tone||'');toast.hidden=false;clearTimeout(hideTimer);if(!stay)hideTimer=setTimeout(function(){toast.hidden=true},4500)}
function api(path,opts){opts=opts||{};opts.credentials='same-origin';opts.headers={'x-stm-tools':'1','content-type':'application/json'};return fetch(path,opts).then(function(r){return r.json().catch(function(){return{}}).then(function(b){b.__ok=r.ok;b.__status=r.status;return b})})}
function refusal(b){var c=b&&b.error&&b.error.code;return(c&&T.refusals[c])||(c==='operation_running'?T.busy:null)||(b&&b.error&&b.error.message)||T.failed}
var working=false;
function follow(id){api('/__stm/tools/job?id='+encodeURIComponent(id)).then(function(j){if(!j.__ok){finish(T.failed,'bad');return}if(j.state==='succeeded'){finish(T.done,'ok');return}if(j.state==='failed'||j.state==='canceled'){finish(j.error||T.failed,'bad');return}say(T.started+' '+Math.round(j.progress||0)+'%'+(j.step?' · '+j.step:''),'',true);setTimeout(function(){follow(id)},1500)}).catch(function(){setTimeout(function(){follow(id)},3000)})}
function finish(msg,tone){working=false;handle.removeAttribute('data-busy');say(msg,tone)}
function backup(target){if(working)return;working=true;handle.setAttribute('data-busy','');api('/__stm/tools/backup',{method:'POST',body:JSON.stringify({target:target})}).then(function(b){if(!b.__ok){finish(refusal(b),'bad');return}if(b.unchanged){finish(T.unchanged,'ok');return}if(b.jobId){say(T.started,'',true);follow(b.jobId)}else finish(T.done,'ok')}).catch(function(){finish(T.failed,'bad')})}
/* The log panel: compact or detailed in one button - compact on a phone and
   detailed with a mouse until somebody chooses - and resized by its edges. */
var compact=(function(){var v=load(LCOMPACT);return v===null?matchMedia('(max-width: 640px)').matches:v==='true'})();
function setCompact(v){compact=v;if(v)logs.setAttribute('data-compact','');else logs.removeAttribute('data-compact');density.textContent=v?T.detailed:T.compact;var b=density.parentNode;b.setAttribute('aria-pressed',v?'true':'false');b.setAttribute('title',v?T.detailed:T.compact)}
setCompact(compact);
var size=(function(){try{return JSON.parse(load(LSIZE)||'null')||{}}catch(e){return{}}})();
function applySize(){if(size.width)logs.style.setProperty('--logs-width',size.width+'px');if(size.height)logs.style.setProperty('--logs-height',size.height+'px')}
applySize();
function setMax(on){if(on)logs.setAttribute('data-max','');else logs.removeAttribute('data-max');logsMax.setAttribute('aria-label',on?T.restore:T.maximize);logsMax.setAttribute('title',on?T.restore:T.maximize)}
logs.addEventListener('pointerdown',function(e){var edge=e.target.closest&&e.target.closest('[data-resize]');if(!edge)return;e.preventDefault();var kind=edge.getAttribute('data-resize'),r=logs.getBoundingClientRect(),sx=e.clientX,sy=e.clientY,w=r.width,h=r.height;edge.setPointerCapture(e.pointerId);root.setAttribute('data-resizing','');setMax(false);
function move(m){if(kind!=='top')size.width=Math.min(innerWidth-16,Math.max(280,w+sx-m.clientX));if(kind!=='left')size.height=Math.min(innerHeight-16,Math.max(160,h+sy-m.clientY));applySize()}
function end(){root.removeAttribute('data-resizing');edge.removeEventListener('pointermove',move);edge.removeEventListener('pointerup',end);edge.removeEventListener('pointercancel',end);store(LSIZE,JSON.stringify(size))}
edge.addEventListener('pointermove',move);edge.addEventListener('pointerup',end);edge.addEventListener('pointercancel',end)});
var search=document.getElementById('search'),query=document.getElementById('query'),nomatch=document.getElementById('nomatch'),searchBtn=document.getElementById('searchbtn');
/* Each line keeps what it is searched by - the words shown and the source -
   so a filter is one pass over the lines already on the page. */
function fold(v){return v.normalize('NFD').replace(/[\\u0300-\\u036f]+/g,'').replace(/\\u0111/g,'d').replace(/\\u0110/g,'D').toLowerCase()}
var filterBox=document.getElementById('filter'),filterBtn=document.getElementById('filterbtn'),source='all';
function matches(p){var q=fold(query.value.trim());return(source==='all'||p.getAttribute('data-source')===source)&&(!q||(p.getAttribute('data-text')||'').indexOf(q)!==-1)}
function filter(){var any=false,q=query.value.trim()||source!=='all';Array.prototype.forEach.call(lines.children,function(p){if(p.classList.contains('empty'))return;var ok=matches(p);if(ok){p.removeAttribute('data-miss');any=true}else p.setAttribute('data-miss','')});nomatch.hidden=!q||any}
query.addEventListener('input',filter);
query.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();closeSearch()}});
function closeSearch(){query.value='';filter();search.hidden=true;searchBtn.setAttribute('aria-pressed','false')}
var cursor=0,logTimer=0;
function pad(n){return(n<10?'0':'')+n}
function render(list){if(!list.length)return;var empty=lines.querySelector('.empty');if(empty)empty.remove();var stick=lines.scrollTop+lines.clientHeight>=lines.scrollHeight-40;var frag=document.createDocumentFragment();list.forEach(function(l){var p=document.createElement('p');if(l.level!=='info')p.className=l.level;var d=new Date(l.time),t=document.createElement('time');t.textContent=pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());var s=document.createElement('span');s.className='src';s.textContent=l.source;p.appendChild(t);p.appendChild(s);p.appendChild(document.createTextNode(l.text));p.setAttribute('data-source',l.source);p.setAttribute('data-text',fold(l.source+' '+l.text+' '+(l.english||'')));if(!matches(p))p.setAttribute('data-miss','');frag.appendChild(p)});lines.appendChild(frag);while(lines.children.length>600)lines.removeChild(lines.firstChild);if(query.value.trim()||source!=='all')filter();if(stick)lines.scrollTop=lines.scrollHeight}
function pull(){return api('/__stm/tools/logs?after='+cursor).then(function(b){if(!b.__ok)return;render(b.lines||[]);if(typeof b.next==='number')cursor=b.next})}
function tick(){clearTimeout(logTimer);if(logs.hidden||document.hidden)return;pull().then(function(){logTimer=setTimeout(tick,3000)},function(){logTimer=setTimeout(tick,6000)})}
function openLogs(){logs.hidden=false;tick()}
function closeLogs(){logs.hidden=true;clearTimeout(logTimer)}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&!logs.hidden)tick()});
function act(name){
if(name==='close'){window.close();setTimeout(function(){location.href='/'},200);return}
if(name==='hidebar'){setBar(false);return}
if(name==='togglebar'){if(body.hasAttribute('data-zoom'))unzoom();else setBar(body.getAttribute('data-bar')!=='on');return}
if(name==='fullscreen'){if(body.hasAttribute('data-zoom'))unzoom();else zoom();return}
if(name==='backup-local'){backup('local');return}
if(name==='backup-cloud'){backup('cloud');return}
if(name==='logs'){openLogs();return}
if(name==='logs-close'){closeLogs();return}
if(name==='logs-filter'){filterBox.hidden=!filterBox.hidden;filterBtn.setAttribute('aria-pressed',!filterBox.hidden||source!=='all'?'true':'false');return}
if(name==='logs-search'){if(search.hidden){search.hidden=false;searchBtn.setAttribute('aria-pressed','true');query.focus()}else closeSearch();return}
if(name==='logs-density'){setCompact(!compact);store(LCOMPACT,String(compact));return}
if(name==='logs-max'){setMax(!logs.hasAttribute('data-max'));return}
if(name==='logs-refresh'){lines.innerHTML='';cursor=0;var p=document.createElement('p');p.className='empty';p.textContent=T.logsEmpty;lines.appendChild(p);tick();return}
if(name==='reload'){try{frame.contentWindow.location.reload()}catch(e){frame.src='/'}return}
if(name==='plain'){location.href='/';return}
if(name==='signout'){if(confirm(T.signOutConfirm))location.href='/__stm/logout';return}
}
filterBox.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-source]');if(!b)return;source=b.getAttribute('data-source');Array.prototype.forEach.call(filterBox.children,function(c){c.setAttribute('aria-checked',c===b?'true':'false')});filterBtn.setAttribute('aria-pressed','true');filter()});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-act]');if(!b)return;e.preventDefault();if(menu.contains(b))openMenu(false);act(b.getAttribute('data-act'))});
})();`;
