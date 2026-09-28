import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, CircleAlert, CircleCheck, Info, Megaphone, TriangleAlert } from 'lucide-react';
import { Button, cn, Popover, PopoverContent, PopoverTrigger, Switch } from '../../../packages/ui/src/index.js';
import type { ManagerNotification, MessageParams, NotificationList, NotificationSummary } from '../../../packages/contracts/src/index.js';
import type { MessageKey, Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { currentPush, disablePush, enablePush, pushSupport, testPush, type PushSupport } from './push.js';
import { apiFetch } from './session.js';

/**
 * Parameters that are codes rather than words, turned into words first - the
 * same rule the manager applies to a push, so both say the same sentence.
 */
const WORD_PARAMS: Readonly<Record<string, string>> = { job: 'notify.jobs', what: 'notify.quota' };

export function notificationText(t: Translate, locale: LocaleCode, item: ManagerNotification): { title: string; body: string } {
  if (item.broadcast) {
    return { title: item.broadcast.title[locale] || item.broadcast.title.en, body: item.broadcast.body[locale] || item.broadcast.body.en };
  }
  const params: MessageParams | undefined = item.params ? Object.fromEntries(Object.entries(item.params).map(([key, value]) => {
    const group = WORD_PARAMS[key];
    if (!group) return [key, value];
    const word = t(`${group}.${String(value)}` as MessageKey);
    return [key, word.startsWith('notify.') ? String(value) : word];
  })) : undefined;
  return { title: t(`notify.${item.kind}.title` as MessageKey, params), body: t(`notify.${item.kind}.body` as MessageKey, params) };
}

function when(iso: string, locale: LocaleCode): string {
  const elapsed = Date.now() - Date.parse(iso);
  const format = new Intl.RelativeTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { numeric: 'auto' });
  if (elapsed < 60_000) return format.format(0, 'second');
  if (elapsed < 3_600_000) return format.format(-Math.round(elapsed / 60_000), 'minute');
  if (elapsed < 86_400_000) return format.format(-Math.round(elapsed / 3_600_000), 'hour');
  return new Date(iso).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function levelIcon(item: ManagerNotification): ReactNode {
  if (item.kind === 'broadcast') return <Megaphone className="text-(--primary)" />;
  if (item.level === 'success') return <CircleCheck className="text-(--success)" />;
  if (item.level === 'warning') return <TriangleAlert className="text-(--attention)" />;
  if (item.level === 'error') return <CircleAlert className="text-destructive" />;
  return <Info className="text-muted-foreground" />;
}

/**
 * Whether this device is told, at the foot of the bell.
 *
 * A switch where the browser can take a push; a sentence saying why not where
 * it cannot, since each reason has a different fix and only one of them is a
 * setting.
 */
export function PushToggle({ t, locale, csrfToken }: { t: Translate; locale: LocaleCode; csrfToken: string }) {
  const [support, setSupport] = useState<PushSupport>(() => pushSupport());
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void currentPush().then((found) => { if (!cancelled) { setSubscription(found); setChecked(true); } }).catch(() => { if (!cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, []);

  if (support === 'app') return <p className="text-xs text-muted-foreground">{t('notify.appManaged')}</p>;
  const reason = support === 'needs-home-screen' ? t('notify.pushNeedsHomeScreen')
    : support === 'needs-https' ? t('notify.pushNeedsHttps')
      : support === 'unsupported' ? t('notify.pushUnsupported')
        : support === 'blocked' ? t('notify.pushBlocked')
          : null;

  const toggle = async (on: boolean) => {
    setBusy(true); setNote(null);
    try {
      if (on) {
        const outcome = await enablePush(csrfToken, locale);
        if (outcome === 'blocked') { setSupport('blocked'); return; }
        if (outcome === 'failed') { setNote(t('notify.pushFailed')); return; }
        setSubscription(await currentPush());
      } else if (subscription) {
        await disablePush(csrfToken, subscription);
        setSubscription(null);
      }
    } finally { setBusy(false); }
  };

  return <div className="grid gap-2">
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{t('notify.push')}</span>
      {reason ? null : <Switch checked={subscription !== null} disabled={busy || !checked} onCheckedChange={(on) => void toggle(on)} aria-label={t('notify.push')} />}
    </div>
    {reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
    {subscription ? <Button variant="outline" size="sm" className="justify-self-start" disabled={busy} onClick={() => {
      setBusy(true);
      void testPush(csrfToken, subscription).then((sent) => setNote(sent ? t('notify.pushTestSent') : t('notify.pushFailed'))).finally(() => setBusy(false));
    }}>{t('notify.pushTest')}</Button> : null}
    {note ? <p className="text-xs text-muted-foreground" role="status">{note}</p> : null}
  </div>;
}

/**
 * The bell in the header: a count of what is unread, and the list behind it.
 *
 * The count comes with the console's own clock, so a closed bell costs no
 * request of its own; the list is asked for when the bell is opened, and again
 * only when the newest one changes while it is open.
 */
export function NotificationBell({ t, locale, summary, csrfToken, footer }: {
  t: Translate;
  locale: LocaleCode;
  summary: NotificationSummary | null;
  csrfToken: string;
  /** Below the list: how this device is told, when there is anything to set. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<NotificationList | null>(null);
  const [unread, setUnread] = useState(0);
  const fetched = useRef<string | null>(null);

  useEffect(() => { setUnread(summary?.unread ?? 0); }, [summary?.unread]);

  const load = async () => {
    try {
      const response = await apiFetch(`/api/v1/notifications?locale=${locale}`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const next = await response.json() as NotificationList;
      setList(next);
      fetched.current = next.items[0]?.id ?? null;
      const unseen = next.items.filter((item) => !item.readAt).map((item) => item.id);
      if (unseen.length === 0) return;
      // Seen by being opened. Kept bold in the list until the bell closes.
      const read = await apiFetch('/api/v1/notifications/read', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ ids: unseen }) });
      if (read.ok) setUnread((await read.json() as NotificationSummary).unread);
    } catch {
      // The list stays as it was; the next opening asks again.
    }
  };

  useEffect(() => {
    if (!open) return;
    if (list === null || (summary?.latestId ?? null) !== fetched.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, summary?.latestId]);

  const clear = async () => {
    const response = await apiFetch('/api/v1/notifications', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => null);
    if (response?.ok) { setList({ items: [], unread: 0 }); setUnread(0); fetched.current = null; }
  };

  const items = list?.items ?? [];
  const label = unread > 0 ? `${t('notify.open')} · ${t('notify.unread', { count: unread })}` : t('notify.open');
  return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next && list) setList({ ...list, items: list.items.map((item) => (item.readAt ? item : { ...item, readAt: new Date().toISOString() })) }); }}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="icon-sm" className="relative" aria-label={label} title={label}>
        <Bell />
        {unread > 0 ? <span className="bell-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span> : null}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" collisionPadding={12} className="bell-panel w-[min(24rem,calc(100vw-24px))] p-0">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <span className="text-sm font-semibold">{t('notify.title')}</span>
        {items.length > 0 ? <Button variant="ghost" size="sm" onClick={() => void clear()}>{t('notify.clear')}</Button> : null}
      </div>
      <div className="bell-list">
        {list === null
          ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          : items.length === 0
            ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('notify.empty')}</p>
            : items.map((item) => {
              const text = notificationText(t, locale, item);
              return <div key={item.id} className={cn('bell-item', !item.readAt && 'is-unread')}>
                <span className="bell-icon" aria-hidden="true">{levelIcon(item)}</span>
                <div className="grid min-w-0 gap-0.5">
                  <span className="bell-title">{text.title}</span>
                  {text.body ? <span className="bell-body">{text.body}</span> : null}
                  <span className="bell-when">
                    {when(item.createdAt, locale)}
                    {item.broadcast?.url ? <> · <a href={item.broadcast.url} target="_blank" rel="noopener noreferrer">{t('notify.openLink')}</a></> : null}
                  </span>
                </div>
              </div>;
            })}
      </div>
      {footer ? <div className="border-t px-4 py-3">{footer}</div> : null}
    </PopoverContent>
  </Popover>;
}
