import { inPhoneApp } from './oauth.js';
import { apiFetch } from './session.js';

/**
 * Whether this browser can be sent a push, and if not, why not.
 *
 * Each answer is something different to tell the reader: the Android app
 * already shows these as phone notifications; iPhone and iPad only allow it
 * from the console added to the Home Screen; everything else needs a secure
 * origin, which the console's https link is and a LAN address is not.
 */
export type PushSupport = 'app' | 'needs-home-screen' | 'needs-https' | 'unsupported' | 'blocked' | 'ready';

function onAppleMobile(): boolean {
  const agent = navigator.userAgent;
  return /iPhone|iPad|iPod/iu.test(agent) || (/Macintosh/iu.test(agent) && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function pushSupport(): PushSupport {
  if (inPhoneApp()) return 'app';
  if (onAppleMobile() && !standalone()) return 'needs-home-screen';
  if (!window.isSecureContext) return 'needs-https';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ready';
}

function keyBytes(base64url: string): Uint8Array {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ?? await navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** The subscription this browser holds, when the manager also knows it. */
export async function currentPush(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ready' && pushSupport() !== 'blocked') return null;
  const existing = await (await registration()).pushManager.getSubscription();
  if (!existing) return null;
  // Held by the browser but forgotten by the manager - a reinstall, or keys
  // made again - is the same as none: nothing will ever be sent to it.
  const response = await apiFetch(`/api/v1/push?endpoint=${encodeURIComponent(existing.endpoint)}`, { credentials: 'same-origin' });
  if (!response.ok) return null;
  const answer = await response.json() as { publicKey: string; subscribed: boolean };
  return answer.subscribed ? existing : null;
}

export async function enablePush(csrfToken: string, locale: string): Promise<'on' | 'blocked' | 'failed'> {
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') return 'blocked';
    if (permission !== 'granted') return 'failed';
    const keyResponse = await apiFetch('/api/v1/push', { credentials: 'same-origin' });
    if (!keyResponse.ok) return 'failed';
    const { publicKey } = await keyResponse.json() as { publicKey: string };
    const worker = await registration();
    let subscription = await worker.pushManager.getSubscription();
    // Made for another manager's key, or for this one's before it was made
    // again: a push signed with the current key would be refused.
    if (subscription) await subscription.unsubscribe().catch(() => false);
    subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
    const saved = await apiFetch('/api/v1/push/subscriptions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
    });
    return saved.ok ? 'on' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function disablePush(csrfToken: string, subscription: PushSubscription): Promise<void> {
  await apiFetch('/api/v1/push/subscriptions', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => null);
  await subscription.unsubscribe().catch(() => false);
}
