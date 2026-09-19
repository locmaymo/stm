/**
 * Where the floating control over a full-screen SillyTavern rests.
 *
 * It sits against one edge at some height, the way a phone's assistive button
 * does, rather than at a free point: a free point is wherever the finger let
 * go, which is often on top of the thing it was moved away from.
 */
export interface HandlePlacement {
  readonly side: 'left' | 'right';
  /** Height of the handle's centre, as a share of the window. */
  readonly top: number;
}

/** Right edge, a little above the middle - clear of SillyTavern's top bar and its send box. */
export const DEFAULT_HANDLE: HandlePlacement = { side: 'right', top: 0.42 };

/** How far the resting handle stands off the edge it is against. */
export const HANDLE_EDGE_GAP = 10;

const STORAGE_KEY = 'stm-embed-handle';
/** Keeps the handle off the very top and bottom, where the browser's own gestures live. */
const EDGE_MARGIN = 0.08;

export function clampTop(top: number): number {
  if (!Number.isFinite(top)) return DEFAULT_HANDLE.top;
  return Math.min(1 - EDGE_MARGIN, Math.max(EDGE_MARGIN, top));
}

/** Where a handle let go at (x, y) settles, in a window of that size. */
export function snapHandle(x: number, y: number, width: number, height: number): HandlePlacement {
  return { side: x < width / 2 ? 'left' : 'right', top: clampTop(height > 0 ? y / height : DEFAULT_HANDLE.top) };
}

/**
 * The resting handle's top-left corner, in pixels.
 *
 * Pixels from the left rather than `right: 10px` for a handle on that side,
 * because a finger drags it by its `left` and CSS cannot ease between the two:
 * a handle thrown to the right edge had its `left` taken away and appeared
 * against the edge in the same frame, while one thrown to the left slid there.
 * One property for both sides is what makes both of them slide.
 */
export function handleOffset(placement: HandlePlacement, width: number, height: number, size: number, gap = HANDLE_EDGE_GAP): { readonly left: number; readonly top: number } {
  return {
    left: placement.side === 'left' ? gap : Math.max(gap, width - size - gap),
    top: Math.max(0, clampTop(placement.top) * height - size / 2),
  };
}

export function readHandle(storage: Pick<Storage, 'getItem'> | undefined): HandlePlacement {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (typeof parsed === 'object' && parsed !== null) {
      const { side, top } = parsed as Record<string, unknown>;
      if ((side === 'left' || side === 'right') && typeof top === 'number') return { side, top: clampTop(top) };
    }
  } catch {
    // Unreadable storage is the same as nothing stored.
  }
  return DEFAULT_HANDLE;
}

export function saveHandle(placement: HandlePlacement, storage: Pick<Storage, 'setItem'> | undefined): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(placement)); } catch { /* a private window keeps it for this visit only */ }
}
