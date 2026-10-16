/**
 * The channel the Android app gives the pages it shows, when there is one.
 *
 * The app adds an object named STMApp to its WebView's pages; the console
 * uses it to ask whether chat bubbles are on and to switch them. A browser has
 * no such object, and neither has an app too old to offer it; see
 * packaging/android/app/src/main/java/top/locmaymo/stm/ChatBridge.java for the other end.
 */
interface AppChannel {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void;
}

export interface BubbleState {
  /** Whether a finished reply is a phone notification; on unless the reader turned it off. */
  readonly replies: boolean;
  /** Whether that notification also floats as a bubble. */
  readonly enabled: boolean;
  /** Whether this Android floats conversations as bubbles at all (Android 11 and later). */
  readonly bubbles: boolean;
  /** Whether Android's settings let this app's conversations bubble. */
  readonly allowed: boolean;
}

function channel(): AppChannel | null {
  const found = (globalThis as { STMApp?: AppChannel }).STMApp;
  return found && typeof found.postMessage === 'function' ? found : null;
}

export function hasAppChannel(): boolean {
  return channel() !== null;
}

export function parseBubbleState(data: unknown): BubbleState | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (value?.type !== 'bubbles') return null;
    // An app that does not say is one from before the switch, where replies were always told.
    return { replies: value.replies !== false, enabled: value.enabled === true, bubbles: value.bubbles === true, allowed: value.allowed === true };
  } catch {
    return null;
  }
}

/**
 * Ask the app about reply notifications and chat bubbles, or change them:
 * `replies` switches the notifications, `enabled` the bubbles, `settings`
 * opens Android's bubble settings. Answers with the state after.
 */
export function bubbleRequest(change: { replies?: boolean; enabled?: boolean; settings?: boolean } = {}, timeoutMs = 3000): Promise<BubbleState | null> {
  const app = channel();
  if (!app) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (state: BubbleState | null) => {
      clearTimeout(timer);
      app.removeEventListener('message', listener);
      resolve(state);
    };
    const listener = (event: MessageEvent<string>) => {
      const state = parseBubbleState(event.data);
      if (state) done(state);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    app.addEventListener('message', listener);
    app.postMessage(JSON.stringify({ type: 'bubbles', ...change }));
  });
}

/**
 * Show SillyTavern from `url` in the app's own SillyTavern page. The app runs
 * one, so a chat bubble and the app never hold the same chat twice; a frame
 * inside the console would be a second. False when there is no app to ask.
 */
export function openInApp(url: string): boolean {
  const app = channel();
  if (!app) return false;
  app.postMessage(JSON.stringify({ type: 'open', url }));
  return true;
}

/** What the app can do for the console beyond the channel itself. */
export interface AppFeatures {
  /** Whether the app sends a zip from the phone itself; see `importZipFromApp`. */
  readonly importZip: boolean;
  /** Whether Termux is on the phone, so a SillyTavern in it can be moved here. */
  readonly termux: boolean;
  /** Whether to offer that move: Termux is there and the offer was never answered. */
  readonly termuxOffer: boolean;
  /** Whether the app installs a newer release of itself; see `updateApp`. */
  readonly appUpdate: boolean;
}

const NO_FEATURES: AppFeatures = { importZip: false, termux: false, termuxOffer: false, appUpdate: false };

/** What the app said it can do; anything it did not say, it cannot. */
export function parseFeatures(data: unknown): AppFeatures | null {
  const value = parseMessage(data);
  if (value?.type !== 'features') return null;
  return { importZip: value.importZip === true, termux: value.termux === true, termuxOffer: value.termuxOffer === true, appUpdate: value.appUpdate === true };
}

let asked: Promise<AppFeatures> | null = null;

/**
 * Ask the app what it can do, once per page. An app that does not answer -
 * one from before the question, or no app at all - can do none of it.
 */
export function appFeatures(timeoutMs = 1500): Promise<AppFeatures> {
  const app = channel();
  if (!app) return Promise.resolve(NO_FEATURES);
  asked ??= new Promise((resolve) => {
    const done = (features: AppFeatures) => {
      clearTimeout(timer);
      app.removeEventListener('message', listener);
      resolve(features);
    };
    const listener = (event: MessageEvent<string>) => {
      const features = parseFeatures(event.data);
      if (features) done(features);
    };
    const timer = setTimeout(() => done(NO_FEATURES), timeoutMs);
    app.addEventListener('message', listener);
    app.postMessage(JSON.stringify({ type: 'features' }));
  });
  return asked;
}

/** How an import the app runs is going; see `importZipFromApp`. */
export type ImportEvent =
  | { readonly state: 'picked'; readonly name: string; readonly size: number }
  | { readonly state: 'progress'; readonly sent: number; readonly total: number }
  | { readonly state: 'done'; readonly status: number; readonly body: string }
  | { readonly state: 'canceled' }
  | { readonly state: 'failed'; readonly message: string; readonly code?: string; readonly status?: number; readonly body?: string };

export function parseImportEvent(data: unknown): ImportEvent | null {
  const value = parseMessage(data);
  if (value?.type !== 'import') return null;
  const number = (key: string): number => (typeof value[key] === 'number' ? value[key] as number : -1);
  const text = (key: string): string => (typeof value[key] === 'string' ? value[key] as string : '');
  switch (value.state) {
    case 'picked': return { state: 'picked', name: text('name'), size: number('size') };
    case 'progress': return { state: 'progress', sent: number('sent'), total: number('total') };
    case 'done': return { state: 'done', status: number('status'), body: text('body') };
    case 'canceled': return { state: 'canceled' };
    case 'failed': return {
      state: 'failed',
      message: text('message'),
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(typeof value.status === 'number' ? { status: value.status, body: text('body') } : {}),
    };
    default: return null;
  }
}

/**
 * Where the app gets what it sends: a zip the reader picks on the phone, or
 * the SillyTavern in Termux, zipped as it is read.
 */
export type ImportSource = 'zip' | 'termux';

/**
 * Have the app pick a zip on the phone, or Termux's folder, and send it to
 * the manager.
 *
 * The app sends it through the same upload this page uses, with this page's
 * sign-in, so what comes back is what finishing an upload answers. Resolves
 * with how it ended - done, canceled or failed; the pick and the progress
 * before that go to `onEvent`. Aborting `signal` asks the app to stop.
 */
export function importZipFromApp(csrfToken: string, onEvent: (event: ImportEvent) => void, signal?: AbortSignal, source: ImportSource = 'zip'): Promise<ImportEvent | null> {
  const app = channel();
  if (!app) return Promise.resolve(null);
  return new Promise((resolve) => {
    const stop = () => app.postMessage(JSON.stringify({ type: 'importCancel' }));
    const listener = (event: MessageEvent<string>) => {
      const update = parseImportEvent(event.data);
      if (!update) return;
      if (update.state === 'picked' || update.state === 'progress') { onEvent(update); return; }
      app.removeEventListener('message', listener);
      signal?.removeEventListener('abort', stop);
      resolve(update);
    };
    app.addEventListener('message', listener);
    signal?.addEventListener('abort', stop, { once: true });
    app.postMessage(JSON.stringify({ type: source === 'termux' ? 'importTermux' : 'importZip', csrf: csrfToken }));
  });
}

/**
 * The offer to move a SillyTavern over from Termux is answered: "No thanks"
 * (`declined`), which the app is told and remembers, or a move that went
 * through, which the app already wrote down itself. Either way this page
 * stops offering it too, without asking the app again.
 */
export function answerTermuxOffer(declined: boolean): void {
  if (declined) channel()?.postMessage(JSON.stringify({ type: 'termuxOffer', dismiss: true }));
  asked = asked?.then((features) => ({ ...features, termuxOffer: false })) ?? null;
}

/**
 * How an update the app installs is going; see `updateApp`.
 *
 * `permission`: Android's switch that lets the app install apps is open, and
 * the app goes on by itself once the reader is back. `installing`: the
 * manager is stopping and Android is about to ask, so this page is about to
 * go - there is nothing after it. A failure carries a `code`: `network`,
 * `missing` (the release has no APK for this phone), `checksum`,
 * `permission` or `notNewer`.
 */
export type AppUpdateEvent =
  | { readonly state: 'progress'; readonly received: number; readonly total: number }
  | { readonly state: 'permission' }
  | { readonly state: 'installing' }
  | { readonly state: 'canceled' }
  | { readonly state: 'failed'; readonly code: string };

export function parseAppUpdateEvent(data: unknown): AppUpdateEvent | null {
  const value = parseMessage(data);
  if (value?.type !== 'appUpdate') return null;
  switch (value.state) {
    case 'progress': return {
      state: 'progress',
      received: typeof value.received === 'number' ? value.received : 0,
      total: typeof value.total === 'number' ? value.total : -1,
    };
    case 'permission': return { state: 'permission' };
    case 'installing': return { state: 'installing' };
    case 'canceled': return { state: 'canceled' };
    case 'failed': return { state: 'failed', code: typeof value.code === 'string' ? value.code : '' };
    default: return null;
  }
}

/**
 * Have the app download `version` of itself and install it.
 *
 * Resolves with how it ended - installing, canceled or failed; the progress
 * and the permission step before that go to `onEvent`. Null when there is no
 * app to ask. Aborting `signal` asks the app to stop downloading.
 */
export function updateApp(version: string, onEvent: (event: AppUpdateEvent) => void, signal?: AbortSignal): Promise<AppUpdateEvent | null> {
  const app = channel();
  if (!app) return Promise.resolve(null);
  return new Promise((resolve) => {
    const stop = () => app.postMessage(JSON.stringify({ type: 'appUpdateCancel' }));
    const listener = (event: MessageEvent<string>) => {
      const update = parseAppUpdateEvent(event.data);
      if (!update) return;
      if (update.state === 'progress' || update.state === 'permission') { onEvent(update); return; }
      app.removeEventListener('message', listener);
      signal?.removeEventListener('abort', stop);
      resolve(update);
    };
    app.addEventListener('message', listener);
    signal?.addEventListener('abort', stop, { once: true });
    app.postMessage(JSON.stringify({ type: 'appUpdate', version }));
  });
}

function parseMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as unknown;
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
