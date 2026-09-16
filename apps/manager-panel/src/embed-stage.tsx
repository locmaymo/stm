import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, Maximize2, Minus, PanelTop, X } from 'lucide-react';
import type { Translate } from './i18n.js';
import { browserStorage } from './preferences.js';
import { readHandle, saveHandle, snapHandle, type HandlePlacement } from './embed-handle.js';

/** Tall enough for the four entries, so the menu can be kept on screen. */
const MENU_HEIGHT = 190;

/** Beside the handle, moved up where the handle is too low for the menu to fit under it. */
function menuTop(placement: HandlePlacement): number {
  const wanted = placement.top * window.innerHeight - HANDLE_SIZE / 2;
  return Math.max(8, Math.min(wanted, window.innerHeight - MENU_HEIGHT - 8));
}

/** How far a press may wander and still be a tap rather than a drag. */
const TAP_SLOP = 6;
const HANDLE_SIZE = 48;

export interface EmbedStageProps {
  readonly t: Translate;
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
 * Without the bar the way back is a floating button that can be dragged to
 * either edge, the way a phone's assistive button is. The old way back was a
 * fixed tab in the top right corner, which is exactly where SillyTavern keeps
 * the button that opens the character list - so the one was always being
 * pressed instead of the other.
 */
export function EmbedStage({ t, open, url, openUrl, onMinimize, onClose }: EmbedStageProps) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
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
      if (zoomed) unzoom(); else onMinimize();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return <div ref={stage} className="embed-stage" hidden={!open} aria-hidden={!open} data-dragging={dragging || undefined}>
    {zoomed
      ? <EmbedHandle t={t} url={openUrl} onShowBar={unzoom} onMinimize={minimize} onClose={close} onDragging={setDragging} />
      : <div className="embed-bar">
        <div className="embed-lights" role="group" aria-label={t('console.embedWindow')}>
          <button type="button" className="embed-light embed-light-close" onClick={close} aria-label={t('console.embedClose')} title={t('console.embedCloseHint')}><X aria-hidden="true" /></button>
          <button type="button" className="embed-light embed-light-minimize" onClick={minimize} aria-label={t('console.embedMinimize')} title={t('console.embedMinimizeHint')}><Minus aria-hidden="true" /></button>
          <button type="button" className="embed-light embed-light-zoom" onClick={zoom} aria-label={t('console.embedZoom')} title={t('console.embedZoomHint')}><Maximize2 aria-hidden="true" /></button>
        </div>
        <span className="embed-title">SillyTavern</span>
        <a className="embed-bar-link" href={openUrl} target="_blank" rel="noopener noreferrer" title={t('console.openInNewTab')}><ArrowUpRight aria-hidden="true" /><span>{t('console.openInTab')}</span></a>
      </div>}
    <iframe
      className="embed-frame"
      src={url}
      title="SillyTavern"
      allow="clipboard-write; fullscreen; microphone"
    />
  </div>;
}

/**
 * The floating control shown while SillyTavern has the whole screen.
 *
 * Dragged, it follows the finger and settles against the nearer edge, and
 * remembers where. Tapped, it opens the few things the hidden bar held.
 */
function EmbedHandle({ t, url, onShowBar, onMinimize, onClose, onDragging }: { t: Translate; url: string; onShowBar: () => void; onMinimize: () => void; onClose: () => void; onDragging: (dragging: boolean) => void }) {
  const [placement, setPlacement] = useState<HandlePlacement>(() => readHandle(browserStorage()));
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

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
    : { [placement.side]: 10, top: `calc(${placement.top * 100}% - ${HANDLE_SIZE / 2}px)` };
  const act = (work: () => void) => () => { setMenuOpen(false); work(); };

  return <>
    {/* Over the frame, so a tap anywhere else closes the menu rather than
        going through to SillyTavern and leaving the menu hanging. */}
    {menuOpen ? <div className="embed-menu-scrim" onClick={() => setMenuOpen(false)} /> : null}
    <button
      type="button"
      className="embed-handle"
      data-active={point !== null || menuOpen || undefined}
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
      ? <div className="embed-menu" data-side={placement.side} style={{ [placement.side]: HANDLE_SIZE + 18, top: menuTop(placement) }} role="menu">
        <button type="button" role="menuitem" onClick={act(onShowBar)}><PanelTop aria-hidden="true" />{t('console.showBar')}</button>
        <button type="button" role="menuitem" onClick={act(onMinimize)}><Minus aria-hidden="true" />{t('console.embedMinimize')}</button>
        <a role="menuitem" href={url} target="_blank" rel="noopener noreferrer" onClick={() => setMenuOpen(false)}><ArrowUpRight aria-hidden="true" />{t('console.openInTab')}</a>
        <button type="button" role="menuitem" className="embed-menu-danger" onClick={act(onClose)}><X aria-hidden="true" />{t('console.embedClose')}</button>
      </div>
      : null}
  </>;
}
