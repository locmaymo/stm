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
