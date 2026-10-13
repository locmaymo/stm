import { useCallback, useEffect, useRef, useState } from 'react';
import { History, LoaderCircle, PowerOff, Puzzle, TriangleAlert } from 'lucide-react';
import {
  Alert, AlertDescription, Button, Card, CardContent, CardHeader, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Label, useToast,
} from '../../../packages/ui/src/index.js';
import type { Job, VersionSwitchStatus } from '../../../packages/contracts/src/index.js';
import type { Fail, Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { apiFetch } from './session.js';

/** How often the overview asks again: a version breaks extensions as their pages are opened. */
const POLL_MS = 60_000;

/**
 * The way back from the last SillyTavern version change, on the overview.
 *
 * Shown in two cases. The manager already took a version back because it
 * would not run with the reader's data, and says so once. Or the version runs
 * but extensions started failing on it, and the reader is offered to switch
 * those off, to go back to the previous version, or to leave it.
 *
 * Going back keeps the data as it is now. Putting the data back from the copy
 * taken before the switch is a separate, unticked choice with the cost said
 * next to it, and it is not offered where there is no such copy.
 */
export function VersionSwitchCard({ t, fail, locale, csrfToken, onOpenExtensions }: { t: Translate; fail: Fail; locale: LocaleCode; csrfToken: string | null; onOpenExtensions: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<VersionSwitchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoreData, setRestoreData] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/v1/installations/switch', { credentials: 'same-origin' });
      if (response.ok && alive.current) setStatus(await response.json() as VersionSwitchStatus);
    } catch { /* the card is an extra; without an answer it simply is not shown */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const follow = async (started: Job): Promise<Job> => {
    let current = started;
    while (alive.current && current.state === 'running') {
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(current.id)}`, { credentials: 'same-origin' });
      if (!response.ok) break;
      current = await response.json() as Job;
    }
    return current;
  };

  const act = async (path: string, body: unknown, done: string) => {
    if (!csrfToken) return;
    setBusy(true);
    try {
      const response = await apiFetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null) as { job?: Job } | null;
      if (!response.ok) { toast({ title: fail.body(payload, t('extensions.taskFailed')), tone: 'destructive' }); return; }
      const finished = payload?.job ? await follow(payload.job) : null;
      if (finished && finished.state !== 'succeeded') toast({ title: fail.of(finished.errorCode, finished.error, t('extensions.taskFailed')), tone: 'destructive' });
      else if (done) toast({ title: done, tone: 'success' });
    } finally {
      if (alive.current) { setBusy(false); await load(); }
    }
  };

  const record = status?.switch ?? null;
  if (!status || !record || record.dismissed) return null;
  const dismiss = () => void act('/api/v1/installations/switch/dismiss', {}, '');
  const names = status.broken.map((item) => item.displayName).join(', ');
  const working = busy || status.job !== null;

  if (record.outcome === 'rolledBack' || record.outcome === 'rollbackFailed') {
    const failed = record.outcome === 'rollbackFailed';
    return <Card>
      <CardHeader className="grid-rows-[auto] items-center"><h2 className="panel-title"><TriangleAlert />{t(failed ? 'extensions.switchRollbackFailedTitle' : 'extensions.switchRolledBackTitle', { version: record.ref, previous: record.previousRef })}</h2></CardHeader>
      <CardContent className="grid gap-3">
        {record.reason ? <p className="text-sm break-words text-muted-foreground">{t('extensions.switchRolledBackReason', { reason: record.reason })}</p> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={working} onClick={dismiss}>{t('common.gotIt')}</Button></div>
      </CardContent>
    </Card>;
  }

  if (status.broken.length === 0 && status.job === null) return null;
  const since = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.at));
  const hasExtensions = status.broken.some((item) => item.kind === 'extension');
  return <Card>
    <CardHeader className="grid-rows-[auto] items-center"><h2 className="panel-title"><Puzzle />{t('extensions.switchBrokenTitle', { version: record.ref })}</h2></CardHeader>
    <CardContent className="grid gap-3">
      {names ? <p className="text-sm break-words text-muted-foreground">{t('extensions.switchBrokenBody', { names })}</p> : null}
      {status.job ? <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite"><LoaderCircle className="size-4 animate-spin" />{t('notify.jobs.versionRollback')}</p> : null}
      <div className="flex flex-wrap gap-2">
        {hasExtensions ? <Button size="sm" disabled={working || !csrfToken} onClick={() => void act('/api/v1/extensions/disable-broken', {}, t('extensions.switchDisableDone'))}><PowerOff />{t('extensions.switchDisableBroken')}</Button> : null}
        <Button size="sm" variant="outline" disabled={working || !csrfToken} onClick={() => { setRestoreData(false); setConfirming(true); }}><History />{t('extensions.switchGoBack', { previous: record.previousRef })}</Button>
        <Button size="sm" variant="ghost" disabled={working} onClick={onOpenExtensions}>{t('extensions.switchShowExtensions')}</Button>
        <Button size="sm" variant="ghost" disabled={working} onClick={dismiss}>{t('extensions.switchIgnore')}</Button>
      </div>
    </CardContent>
    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('extensions.switchGoBackTitle', { previous: record.previousRef })}</DialogTitle>
          <DialogDescription>{t('extensions.switchGoBackBody')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {status.canRestoreData ? <>
            <div className="flex items-start gap-2">
              <Checkbox id="switch-restore-data" checked={restoreData} onCheckedChange={(value) => setRestoreData(value === true)} />
              <Label htmlFor="switch-restore-data" className="leading-snug">{t('extensions.switchRestoreData')}</Label>
            </div>
            {restoreData ? <Alert variant="destructive"><AlertDescription>{t('extensions.switchRestoreDataWarning', { when: since })}</AlertDescription></Alert> : null}
          </> : <p className="text-sm text-muted-foreground">{t(status.saving ? 'extensions.switchSaverNoCopy' : 'extensions.switchNoCopy')}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          <Button variant={restoreData ? 'destructive' : 'default'} onClick={() => { setConfirming(false); void act('/api/v1/installations/switch/back', { restoreData }, t('extensions.switchGoBackDone', { previous: record.previousRef })); }}><History />{t('extensions.switchGoBack', { previous: record.previousRef })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}
