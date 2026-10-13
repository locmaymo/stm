import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, LoaderCircle, Network, RefreshCw, Route } from 'lucide-react';
import { Alert, AlertDescription, Badge, Button, Card, CardAction, CardContent, CardHeader, EmptyState } from '../../../packages/ui/src/index.js';
import { connectionApiProvider, connectionProviderName, type ConnectionKey, type ConnectionProfile, type ConnectionProxy, type ConnectionsOverview } from '../../../packages/contracts/src/index.js';
import type { Translate } from './i18n.js';
import { apiFetch } from './session.js';

/**
 * The keys, proxies and connection profiles SillyTavern keeps.
 *
 * Read off the profile's files by the manager, so the page answers the same
 * with SillyTavern stopped. Keys arrive masked and proxy passwords not at all.
 * SillyTavern stays the place these are used; this page is the overview.
 */
export function ConnectionsPage({ t }: { t: Translate }) {
  const [overview, setOverview] = useState<ConnectionsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/v1/connections', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('connections request failed');
      const next = await response.json() as ConnectionsOverview;
      if (alive.current) { setOverview(next); setFailed(false); }
    } catch {
      if (alive.current) setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const profileNames = new Map((overview?.profiles ?? []).map((profile) => [profile.id, profile.name]));
  const refresh = <Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => void load()}><RefreshCw /></Button>;

  return <div className="grid min-w-0 gap-4">
    {failed ? <Alert variant="destructive"><AlertDescription>{t('connections.loadFailed')}</AlertDescription></Alert> : null}
    {overview && !overview.profile ? <Alert><AlertDescription>{t('connections.noProfile')}</AlertDescription></Alert> : null}
    {overview?.legacySecrets ? <Alert><AlertDescription>{t('connections.legacySecrets')}</AlertDescription></Alert> : null}
    {overview?.unreadable.map((file) => <Alert key={file} variant="destructive"><AlertDescription>{t('connections.unreadable', { file: file === 'secrets' ? 'secrets.json' : 'settings.json' })}</AlertDescription></Alert>)}

    <Section icon={<KeyRound />} title={t('connections.keysTitle')} action={refresh} loading={overview === null && !failed}
      empty={<EmptyState icon={<KeyRound />} title={t('connections.keysEmpty')} description={t('connections.keysEmptyHint')} />}>
      {overview && overview.keys.length > 0 ? <KeyGroups t={t} keys={overview.keys} profileNames={profileNames} /> : null}
    </Section>

    <Section icon={<Route />} title={t('connections.proxiesTitle')} loading={overview === null && !failed}
      empty={<p className="text-sm text-muted-foreground">{t('connections.proxiesEmpty')}</p>}>
      {overview && overview.proxies.length > 0 ? <ul className="grid divide-y">{overview.proxies.map((proxy) => <ProxyRow key={proxy.name} t={t} proxy={proxy} profileNames={profileNames} />)}</ul> : null}
    </Section>

    <Section icon={<Network />} title={t('connections.profilesTitle')} loading={overview === null && !failed}
      empty={<p className="text-sm text-muted-foreground">{t('connections.profilesEmpty')}</p>}>
      {overview && overview.profiles.length > 0 ? <ul className="grid divide-y">{overview.profiles.map((profile) => <ProfileRow key={profile.id} t={t} profile={profile} />)}</ul> : null}
    </Section>

    <p className="text-xs text-muted-foreground">{t('connections.readNote')}</p>
  </div>;
}

function Section({ icon, title, action, loading, empty, children }: { icon: ReactNode; title: string; action?: ReactNode; loading: boolean; empty: ReactNode; children: ReactNode }) {
  return <Card>
    <CardHeader className="grid-rows-[auto] items-center">
      <h2 className="panel-title">{icon}{title}</h2>
      {action ? <CardAction className="row-span-1 self-center">{action}</CardAction> : null}
    </CardHeader>
    <CardContent className="grid gap-3">
      {loading ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : children ?? empty}
    </CardContent>
  </Card>;
}

/** Keys grouped under their provider, in the order SillyTavern lists them. */
function KeyGroups({ t, keys, profileNames }: { t: Translate; keys: readonly ConnectionKey[]; profileNames: ReadonlyMap<string, string> }) {
  const groups = new Map<string, ConnectionKey[]>();
  for (const key of keys) groups.set(key.secretKey, [...groups.get(key.secretKey) ?? [], key]);
  return <div className="grid gap-4">
    {[...groups.values()].map((group) => {
      const provider = group[0]?.provider ?? '';
      return <section key={group[0]?.secretKey} className="grid gap-1" aria-label={connectionProviderName(provider)}>
        <h3 className="text-sm font-medium">{connectionProviderName(provider)}</h3>
        <ul className="grid divide-y rounded-lg border px-3">
          {group.map((key) => <li key={key.id ?? key.secretKey} className="grid gap-1 py-2.5">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium break-all">{key.label}</span>
              <span className="font-mono text-xs text-muted-foreground">{key.masked}</span>
              {key.active ? <Badge variant="secondary" title={t('connections.keyActiveHint')}>{t('connections.keyActive')}</Badge> : null}
            </span>
            <UsedBy t={t} ids={key.profiles} profileNames={profileNames} />
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}

function ProxyRow({ t, proxy, profileNames }: { t: Translate; proxy: ConnectionProxy; profileNames: ReadonlyMap<string, string> }) {
  return <li className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium break-all">{proxy.name}</span>
      {proxy.selected ? <Badge variant="secondary">{t('connections.proxySelected')}</Badge> : null}
      {proxy.hasPassword ? <Badge variant="outline">{t('connections.proxyHasPassword')}</Badge> : null}
    </span>
    <span className="font-mono text-xs break-all text-muted-foreground">{proxy.url ?? t('connections.noAddress')}</span>
    <UsedBy t={t} ids={proxy.profiles} profileNames={profileNames} />
  </li>;
}

function ProfileRow({ t, profile }: { t: Translate; profile: ConnectionProfile }) {
  const parts = [
    profile.api ? connectionProviderName(connectionApiProvider(profile.api)) : null,
    profile.model,
    profile.proxy ? t('connections.profileProxy', { name: profile.proxy }) : null,
    profile.secretLabel ? t('connections.profileKey', { label: profile.secretLabel }) : null,
  ].filter((part): part is string => Boolean(part));
  return <li className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium break-all">{profile.name}</span>
      {profile.selected ? <Badge variant="secondary">{t('connections.profileSelected')}</Badge> : null}
      <Badge variant="outline">{t(profile.mode === 'tc' ? 'connections.modeText' : 'connections.modeChat')}</Badge>
      {profile.secretId && !profile.secretLabel ? <Badge variant="destructive" title={t('connections.profileKeyMissingHint')}>{t('connections.profileKeyMissing')}</Badge> : null}
    </span>
    <span className="text-sm break-all text-muted-foreground">{parts.length > 0 ? parts.join(' · ') : t('connections.profileEmpty')}</span>
    {profile.apiUrl ? <span className="font-mono text-xs break-all text-muted-foreground">{profile.apiUrl}</span> : null}
  </li>;
}

function UsedBy({ t, ids, profileNames }: { t: Translate; ids: readonly string[]; profileNames: ReadonlyMap<string, string> }) {
  if (ids.length === 0) return null;
  return <span className="text-xs break-all text-muted-foreground">{t('connections.usedBy', { names: ids.map((id) => profileNames.get(id) ?? id).join(', ') })}</span>;
}

