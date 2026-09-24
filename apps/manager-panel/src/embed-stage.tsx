import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Archive, ArrowUpRight, CloudUpload, Maximize2, Minus, PanelTop, RotateCw, ScrollText, X } from 'lucide-react';
import type { Fail, Translate } from './i18n.js';
import { ToolsLogs, useManagerTools } from './embed-tools.js';
import { browserStorage } from './preferences.js';
import { handleOffset, readHandle, saveHandle, snapHandle, HANDLE_EDGE_GAP, type HandlePlacement } from './embed-handle.js';

/** Beside the handle, moved up where the handle is too low for the menu to fit under it. */
function menuTop(placement: HandlePlacement, height: number, menuHeight: number): number {
  const wanted = placement.top * height - HANDLE_SIZE / 2;
  return Math.max(8, Math.min(wanted, height - menuHeight - 8));
}

/** How far a press may wander and still be a tap rather than a drag. */
const TAP_SLOP = 6;
const HANDLE_SIZE = 48;

export interface EmbedStageProps {
  readonly t: Translate;
  readonly fail: Fail;
  readonly catalog: Record<string, unknown>;
  readonly csrfToken: string | null;
  readonly open: boolean;
  /** What the frame loads: the gateway on this machine. */
  readonly url: string;
  /** What "Open in a tab" opens: the best address there is, tunnel first. */
  readonly openUrl: string;
  /** Put the window away and keep SillyTavern loaded behind it. */
  readonly onMinimize: () => void;
  /** Close it for good: the frame is unmounted and opening it again loads SillyTavern afresh. */
  readonly onClose: () => void;
}

/**
 * SillyTavern in a window of its own, over the console.
 *
 * The bar is a window's bar, with the three lights a window has: red closes
 * it and lets the frame go, so the memory SillyTavern holds is freed and the
 * next open is a fresh load; amber puts it away and keeps it loaded, so coming
 * back finds the chat as it was left; green gives SillyTavern the whole screen,
 * bar and all.
 *
 * A floating button that can be dragged to either edge, the way a phone's
 * assistive button is, holds the manager's tools - the same ones the tools
 * window the door serves in its own tab has - and, without the bar, the way
 * back. The old way back was a
 * fixed tab in the top right corner, which is exactly where SillyTavern keeps
 * the button that opens the character list - so the one was always being
 * pressed instead of the other.
 */
export function EmbedStage({ t, fail, catalog, csrfToken, open, url, openUrl, onMinimize, onClose }: EmbedStageProps) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  // Where the frame is pointed, and a key to load it afresh. There is no
  // signing out here: this window belongs to the console, whose own session
  // is what let it in, so the tools window's sign-out has nothing to do.
  const [frameSrc, setFrameSrc] = useState(url);
  const [frameKey, setFrameKey] = useState(0);
  const tools = useManagerTools({ t, fail, csrfToken });
  // A door that moved to another port is followed, the next time the frame loads.
  useEffect(() => { setFrameSrc(url); }, [url]);
  const reload = () => { setFrameSrc(url); setFrameKey((value) => value + 1); };
  /** Whether the browser was asked for full screen, so leaving it can bring the bar back. */
  const wentFullscreen = useRef(false);

  const leaveFullscreen = () => {
    if (wentFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    wentFullscreen.current = false;
  };
  const zoom = () => {
    setZoomed(true);
    // The browser's own full screen where there is one; where there is not
    // (Safari on an iPhone), the page already fills the window without the bar.
    const element = stage.current;
    if (element?.requestFullscreen && !document.fullscreenElement) {
      wentFullscreen.current = true;
      void element.requestFullscreen().catch(() => { wentFullscreen.current = false; });
    }
  };
  const unzoom = () => { leaveFullscreen(); setZoomed(false); };
  const minimize = () => { unzoom(); onMinimize(); };
  const close = () => { unzoom(); onClose(); };

  useEffect(() => {
    // Escape in the browser's full screen is the browser's; out of it the bar
    // comes back as well, rather than leaving a screen with no bar.
    const onFullscreenChange = () => { if (!document.fullscreenElement && wentFullscreen.current) { wentFullscreen.current = false; setZoomed(false); } };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (logsOpen) setLogsOpen(false);
      else if (zoomed) unzoom(); else onMinimize();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return <div ref={stage} className="embed-stage" hidden={!open} aria-hidden={!open} data-dragging={dragging || undefined}>
    {open ? <EmbedHandle
      t={t}
      url={openUrl}
      zoomed={zoomed}
      working={tools.working}
      onToggleBar={zoomed ? unzoom : zoom}
      onMinimize={minimize}
      onClose={close}
      onBackup={(target) => void tools.backup(target)}
      onLogs={() => setLogsOpen(true)}
      onReload={reload}
      onDragging={setDragging}
    /> : null}
    {logsOpen ? <ToolsLogs t={t} catalog={catalog} onClose={() => setLogsOpen(false)} /> : null}
    {zoomed
      ? null
      : <div className="embed-bar">
        <div className="embed-lights" role="group" aria-label={t('console.embedWindow')}>
          <button type="button" className="embed-light embed-light-close" onClick={close} aria-label={t('console.embedClose')} title={t('console.embedCloseHint')}><X aria-hidden="true" /></button>
          <button type="button" className="embed-light embed-light-minimize" onClick={minimize} aria-label={t('console.embedMinimize')} title={t('console.embedMinimizeHint')}><Minus aria-hidden="true" /></button>
          <button type="button" className="embed-light embed-light-zoom" onClick={zoom} aria-label={t('console.embedZoom')} title={t('console.embedZoomHint')}><Maximize2 aria-hidden="true" /></button>
        </div>
        <span className="embed-title">SillyTavern</span>
        <div className="embed-bar-end">
          <a className="embed-bar-link" href={openUrl} target="_blank" rel="noopener noreferrer" title={t('console.openInNewTab')}><ArrowUpRight aria-hidden="true" /><span>{t('console.openInTab')}</span></a>
        </div>
      </div>}
    <iframe
      key={frameKey}
      className="embed-frame"
      src={frameSrc}
      title="SillyTavern"
      allow="clipboard-write; fullscreen; microphone"
    />
  </div>;
}

/**
 * The floating control over SillyTavern.
 *
 * Dragged, it follows the finger and settles against the nearer edge, and
 * remembers where. Tapped, it opens the manager's tools, and the few things
 * the bar holds for when the bar is hidden.
 */
function EmbedHandle({ t, url, zoomed, working, onToggleBar, onMinimize, onClose, onBackup, onLogs, onReload, onDragging }: {
  t: Translate;
  url: string;
  zoomed: boolean;
  working: boolean;
  onToggleBar: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onBackup: (target: 'local' | 'cloud') => void;
  onLogs: () => void;
  onReload: () => void;
  onDragging: (dragging: boolean) => void;
}) {
  const [placement, setPlacement] = useState<HandlePlacement>(() => readHandle(browserStorage()));
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  // Measured rather than assumed, so the menu stays on screen however many
  // entries it has and however tall the text in them wraps.
  const [menuHeight, setMenuHeight] = useState(360);
  useLayoutEffect(() => { if (menuOpen && menu.current) setMenuHeight(menu.current.offsetHeight); }, [menuOpen]);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /*
   * The window's size, watched rather than read once.
   *
   * The resting handle is placed in pixels now, so a window that changed shape
   * under it - a phone turned on its side, a keyboard coming up - would leave
   * it short of the edge it is meant to be against until it was next dragged.
   */
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < TAP_SLOP) return;
    if (!current.moved) { current.moved = true; setMenuOpen(false); onDragging(true); }
    const half = HANDLE_SIZE / 2;
    setPoint({
      x: Math.min(window.innerWidth - half, Math.max(half, event.clientX)),
      y: Math.min(window.innerHeight - half, Math.max(half, event.clientY)),
    });
  };
  const up = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    if (!current.moved) { setMenuOpen((value) => !value); return; }
    const next = snapHandle(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
    setPlacement(next);
    saveHandle(next, browserStorage());
    setPoint(null);
    onDragging(false);
  };
  const cancel = () => { press.current = null; setPoint(null); onDragging(false); };

  const style = point
    ? { left: point.x - HANDLE_SIZE / 2, top: point.y - HANDLE_SIZE / 2 }
    : handleOffset(placement, viewport.width, viewport.height, HANDLE_SIZE);
  const act = (work: () => void) => () => { setMenuOpen(false); work(); };

  return <>
    {/* Over the frame, so a tap anywhere else closes the menu rather than
        going through to SillyTavern and leaving the menu hanging. */}
    {menuOpen ? <div className="embed-menu-scrim" onClick={() => setMenuOpen(false)} /> : null}
    <button
      type="button"
      className="embed-handle"
      data-active={point !== null || menuOpen || undefined}
      data-busy={working || undefined}
      style={style}
      aria-label={t('console.embedControls')}
      aria-expanded={menuOpen}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setMenuOpen((value) => !value); } }}
    ><span aria-hidden="true" /></button>
    {menuOpen && !point
      ? <div ref={menu} className="embed-menu" data-side={placement.side} style={{ [placement.side]: HANDLE_SIZE + HANDLE_EDGE_GAP + 8, top: menuTop(placement, viewport.height, menuHeight) }} role="menu">
        <button type="button" role="menuitem" onClick={act(onToggleBar)}><PanelTop aria-hidden="true" />{zoomed ? t('console.showBar') : t('console.embedHideBar')}</button>
        <button type="button" role="menuitem" onClick={act(onMinimize)}><Minus aria-hidden="true" />{t('console.embedMinimize')}</button>
        <span className="embed-menu-rule" aria-hidden="true" />
        <button type="button" role="menuitem" disabled={working} onClick={act(() => onBackup('local'))}><Archive aria-hidden="true" />{t('console.embedBackupLocal')}</button>
        <button type="button" role="menuitem" disabled={working} onClick={act(() => onBackup('cloud'))}><CloudUpload aria-hidden="true" />{t('console.embedBackupCloud')}</button>
        <button type="button" role="menuitem" onClick={act(onLogs)}><ScrollText aria-hidden="true" />{t('console.embedLogs')}</button>
        <button type="button" role="menuitem" onClick={act(onReload)}><RotateCw aria-hidden="true" />{t('console.embedReload')}</button>
        <a role="menuitem" href={url} target="_blank" rel="noopener noreferrer" onClick={() => setMenuOpen(false)}><ArrowUpRight aria-hidden="true" />{t('console.embedOpenInTab')}</a>
        <span className="embed-menu-rule" aria-hidden="true" />
        <button type="button" role="menuitem" className="embed-menu-danger" onClick={act(onClose)}><X aria-hidden="true" />{t('console.embedClose')}</button>
      </div>
      : null}
  </>;
}
