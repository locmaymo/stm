import { useEffect, useRef, useState, type ReactElement } from 'react';
import { LoaderCircle, MonitorSmartphone } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button } from '../../../packages/ui/src/index.js';
import type { DeviceSyncOutcome, DeviceSyncStatus } from '../../../packages/contracts/src/index.js';
import { apiFetch } from './session.js';
import { machineName } from './addresses.js';
import type { Translate } from './i18n.js';

/**
 * One person's devices sharing one set of data, as the console says it.
 *
 * Three things can need saying, and each is said once, at the top of the page:
 * that the storage this device is connected to is already shared and it could
 * join; that another device has taken over and SillyTavern is stopped here;
 * and what catching up did when both devices had changed the same things.
 */

type SyncAction = 'start' | 'join' | 'resume' | 'leave';

async function post(action: SyncAction, csrfToken: string): Promise<DeviceSyncStatus | null> {
  const response = await apiFetch(`/api/v1/sync/${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
  const payload = await response.json().catch(() => null) as { sync?: DeviceSyncStatus | null; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${String(response.status)}`);
  return payload?.sync ?? null;
}

/**
 * How long a press is taken to be at work when nothing has said otherwise.
 *
 * The manager answers a press at once and does the work after: it reads
 * storage, brings files over, then starts SillyTavern. Until the next status
 * says so, the page has only its own word that anything is happening - and a
 * card that went back to its button in that gap got pressed a second time.
 */
const PRESS_HOLDS_MS = 90_000;

function useSyncAction(csrfToken: string, onStatus: (status: DeviceSyncStatus | null) => void): { busy: boolean; problem: string | null; run: (action: SyncAction) => void } {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const held = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (held.current) clearTimeout(held.current); }, []);
  const run = (action: SyncAction): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    if (held.current) clearTimeout(held.current);
    post(action, csrfToken)
      .then((status) => {
        onStatus(status);
        // Turning sharing on or off is done when it is answered; taking the
        // shared data in has only begun.
        if (action === 'leave' || action === 'start') setBusy(false);
        else held.current = setTimeout(() => { setBusy(false); }, PRESS_HOLDS_MS);
      })
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : String(error)); setBusy(false); });
  };
  return { busy, problem, run };
}

export interface DeviceSyncNoticesProps {
  readonly t: Translate;
  readonly status: DeviceSyncStatus | null;
  readonly outcome: DeviceSyncOutcome | null;
  readonly csrfToken: string;
  /** Whether SillyTavern is on its way up, which is when a device is catching up. */
  readonly starting: boolean;
  readonly onStatus: (status: DeviceSyncStatus | null) => void;
  readonly onOutcomeDismissed: () => void;
}

export function DeviceSyncNotices({ t, status, outcome, csrfToken, starting, onStatus, onOutcomeDismissed }: DeviceSyncNoticesProps): ReactElement | null {
  const { busy, problem, run } = useSyncAction(csrfToken, onStatus);
  const notices: ReactElement[] = [];
  const failed = problem ? <span className="text-xs text-destructive">{t('console.syncFailed', { reason: problem })}</span> : null;

  if (status?.state === 'invited') {
    notices.push(<Alert key="invited">
      <MonitorSmartphone />
      <AlertTitle>{t('console.syncInvitedTitle')}</AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>{t('console.syncInvitedBody', { name: machineName(status.ahead?.label ?? '') })}</span>
        {failed}
        <span><Button size="sm" disabled={busy} onClick={() => run('join')}>{busy ? <LoaderCircle className="animate-spin" /> : null}{t('console.syncJoin')}</Button></span>
      </AlertDescription>
    </Alert>);
  } else if (status?.state === 'catching_up' && (busy || starting)) {
    notices.push(<Alert key="working">
      <LoaderCircle className="animate-spin" />
      <AlertTitle>{t('console.syncWorking')}</AlertTitle>
    </Alert>);
  } else if (status?.state === 'catching_up') {
    const name = machineName(status.ahead?.label ?? '');
    notices.push(<Alert key="ahead">
      <MonitorSmartphone />
      <AlertTitle>{status.ahead ? t('console.syncAheadTitle', { name }) : t('console.syncBehindTitle')}</AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>{status.ahead ? t('console.syncAheadBody', { name, when: new Date(status.ahead.at).toLocaleString() }) : t('console.syncBehindBody')}</span>
        {failed}
        <span><Button size="sm" disabled={busy} onClick={() => run('resume')}>{t('console.syncResume')}</Button></span>
      </AlertDescription>
    </Alert>);
  }

  if (outcome && (outcome.keptBoth.length > 0 || outcome.setAside.length > 0 || outcome.skipped.length > 0)) {
    const name = machineName(outcome.from);
    notices.push(<Alert key="outcome">
      <MonitorSmartphone />
      <AlertTitle>{t('console.syncOutcomeTitle')}</AlertTitle>
      <AlertDescription className="grid gap-2">
        {outcome.keptBoth.length > 0 ? <span>{t('console.syncOutcomeKeptBoth', { count: outcome.keptBoth.length })}</span> : null}
        {outcome.keptBoth.length > 0 ? <ul className="list-disc pl-5 text-xs break-all">{outcome.keptBoth.slice(0, 8).map((file) => <li key={file}>{file.slice(file.lastIndexOf('/') + 1)}</li>)}</ul> : null}
        {outcome.setAside.length > 0 ? <span>{t('console.syncOutcomeSetAside', { count: outcome.setAside.length, name })}</span> : null}
        {outcome.skipped.length > 0 ? <span>{t('console.syncOutcomeSkipped', { count: outcome.skipped.length })}</span> : null}
        <span><Button size="sm" variant="ghost" onClick={() => {
          onOutcomeDismissed();
          void apiFetch('/api/v1/sync/outcome/dismiss', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
        }}>{t('common.gotIt')}</Button></span>
      </AlertDescription>
    </Alert>);
  }

  if (notices.length === 0) return null;
  return <div className="mb-(--section-gap) grid gap-(--section-gap)">{notices}</div>;
}

/** What the sharing row on the backups page says under its name. */
export function deviceSyncHint(t: Translate, status: DeviceSyncStatus | null): string {
  if (!status) return t('console.syncRowOffHint');
  if (status.state === 'invited') return t('console.syncRowInvitedHint', { name: machineName(status.ahead?.label ?? '') });
  if (status.state === 'catching_up') return status.ahead ? t('console.syncRowBehindHint', { name: machineName(status.ahead.label) }) : t('console.syncBehindBody');
  if (!status.syncedAt) return t('console.syncRowOnHintNew');
  return t('console.syncRowOnHint', { when: new Date(status.syncedAt).toLocaleString(), name: machineName(status.writtenBy ?? '') });
}

export interface DeviceSyncControlProps {
  readonly t: Translate;
  readonly status: DeviceSyncStatus | null;
  readonly csrfToken: string;
  readonly onStatus: (status: DeviceSyncStatus | null) => void;
}

/** The button on that row: on, join, or off. */
export function DeviceSyncControl({ t, status, csrfToken, onStatus }: DeviceSyncControlProps): ReactElement {
  const { busy, problem, run } = useSyncAction(csrfToken, onStatus);
  return <div className="flex flex-col items-end gap-1">
    {status === null
      ? <Button size="sm" disabled={busy} onClick={() => run('start')}><MonitorSmartphone />{t('console.syncTurnOn')}</Button>
      : status.state === 'invited'
      ? <Button size="sm" disabled={busy} onClick={() => run('join')}><MonitorSmartphone />{t('console.syncJoin')}</Button>
      : <Button size="sm" variant="outline" disabled={busy} onClick={() => run('leave')}>{t('console.syncTurnOff')}</Button>}
    {problem ? <span className="text-xs text-destructive">{t('console.syncFailed', { reason: problem })}</span> : null}
  </div>;
}
