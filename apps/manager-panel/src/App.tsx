import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Archive, ArrowUpRight, BarChart3, Code2, Copy, Database, Download,
  Globe2, LayoutDashboard, Moon, Package, Plus, ScrollText, Settings2,
  Sun, Upload, Users, X,
} from 'lucide-react';
import {
  Badge, Button, Card, CardAction, CardContent, CardFooter, CardHeader,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarTrigger, Switch, Tooltip, TooltipContent, TooltipTrigger, useSidebar,
} from '../../../packages/ui/src/index.js';
import { translator, type Translate } from './i18n.js';
import { browserStorage, readPreferences, savePreferences, type Preferences } from './preferences.js';

const navigation = [
  { id: 'overview', icon: LayoutDashboard }, { id: 'installations', icon: Package },
  { id: 'profiles', icon: Users }, { id: 'backups', icon: Archive },
  { id: 'metrics', icon: BarChart3 }, { id: 'logs', icon: ScrollText },
  { id: 'config', icon: Code2 }, { id: 'settings', icon: Settings2 },
] as const;
type PageId = typeof navigation[number]['id'];
type Navigate = (page: PageId) => void;

function pageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  return navigation.find(({ id }) => id === hash)?.id ?? 'overview';
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [preferences, setPreferences] = useState(() => readPreferences(browserStorage()));
  const [version, setVersion] = useState('latest');
  const [logSource, setLogSource] = useState('sillytavern');
  const t = translator(preferences.locale);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
    document.documentElement.lang = preferences.locale;
    document.documentElement.dataset.theme = preferences.theme;
    savePreferences(preferences, browserStorage());
  }, [preferences]);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate: Navigate = (next) => { window.location.hash = next; setPage(next); window.scrollTo({ top: 0 }); };
  const changePreferences = (update: Partial<Preferences>) => setPreferences((current) => ({ ...current, ...update }));
  const installation = <InstallationPanel t={t} version={version} onVersionChange={setVersion} />;
  const logs = <LogsPanel t={t} source={logSource} onSourceChange={setLogSource} navigate={navigate} expanded={page === 'logs'} />;

  return (
    <SidebarProvider style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.75rem' } as CSSProperties}>
      <AppSidebar page={page} navigate={navigate} t={t} />
      <SidebarInset className="min-w-0">
        <header className="site-header">
          <SidebarTrigger label={t('console.toggleNavigation')} className="size-10 shrink-0" />
          <h1>{t(`nav.${page}`)}</h1>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LanguageControl t={t} preferences={preferences} onChange={changePreferences} />
            <Button variant="ghost" size="icon" className="size-10" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => changePreferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
              {preferences.theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <div className="page-body">
          {page === 'overview' ? <div className="core-grid">{installation}<AccessPanel t={t} /><DataPanel t={t} navigate={navigate} />{logs}</div> : page === 'installations' ? <div className="max-w-2xl">{installation}</div> : page === 'logs' ? logs : page === 'settings' ? <SettingsPanel t={t} preferences={preferences} onChange={changePreferences} /> : <ResourcePanel page={page} t={t} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({ page, navigate, t }: { page: PageId; navigate: Navigate; t: Translate }) {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon" mobileTitle={t('console.navigation')}>
      <SidebarHeader className="brand-header">
        <a href="#overview" aria-label="SillyTavern Manager" className="brand" onClick={() => setOpenMobile(false)}><span className="brand-symbol" aria-hidden="true">ST</span><span className="truncate group-data-[collapsible=icon]:hidden">ST Manager</span></a>
        {isMobile ? <Button variant="ghost" size="icon" className="ml-auto shrink-0" aria-label={t('console.closeNavigation')} onClick={() => setOpenMobile(false)}><X /></Button> : null}
      </SidebarHeader>
      <SidebarContent><SidebarGroup><SidebarGroupContent><nav aria-label={t('console.navigation')}><SidebarMenu>{navigation.map(({ id, icon: Icon }) => <SidebarMenuItem key={id}><SidebarMenuButton asChild isActive={page === id} tooltip={t(`nav.${id}`)} className="h-11 gap-3 px-3 text-sm md:h-10 group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:p-3!"><a href={`#${id}`} aria-current={page === id ? 'page' : undefined} aria-label={t(`nav.${id}`)} onClick={() => { navigate(id); setOpenMobile(false); }}><Icon className="size-4" /><span>{t(`nav.${id}`)}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></nav></SidebarGroupContent></SidebarGroup></SidebarContent>
    </Sidebar>
  );
}

function LanguageControl({ t, preferences, onChange }: { t: Translate; preferences: Preferences; onChange: (value: Partial<Preferences>) => void }) {
  return <div className="language-control" role="group" aria-label={t('dashboard.language')}>{(['en', 'vi'] as const).map((locale) => <button key={locale} type="button" aria-pressed={preferences.locale === locale} onClick={() => onChange({ locale })}>{locale.toUpperCase()}</button>)}</div>;
}

function PanelHeading({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <CardHeader><h2 className="panel-title">{icon}{children}</h2>{action ? <CardAction>{action}</CardAction> : null}</CardHeader>;
}

function Unavailable({ t, children }: { t: Translate; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md" aria-label={t('console.unavailable')}>{children}</span></TooltipTrigger><TooltipContent>{t('console.unavailable')}</TooltipContent></Tooltip>;
}

function InstallationPanel({ t, version, onVersionChange }: { t: Translate; version: string; onVersionChange: (value: string) => void }) {
  return <Card data-tour="installation"><PanelHeading icon={<Package />} action={<Badge variant="outline" className="status-attention">{t('dashboard.notInstalled')}</Badge>}>SillyTavern</PanelHeading><CardContent className="flex-1"><label className="field-label" htmlFor="install-version">{t('dashboard.version')}</label><Select value={version} onValueChange={onVersionChange}><SelectTrigger id="install-version" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="latest">latest · {t('dashboard.latest')}</SelectItem><SelectItem value="release">release</SelectItem><SelectItem value="staging">staging</SelectItem></SelectContent></Select></CardContent><CardFooter><Unavailable t={t}><Button disabled><Download />{t('dashboard.install')}</Button></Unavailable></CardFooter></Card>;
}

function AccessPanel({ t }: { t: Translate }) {
  return <Card data-tour="public-access"><PanelHeading icon={<Globe2 />} action={<Badge variant="secondary">{t('dashboard.offline')}</Badge>}>{t('console.publicAccess')}</PanelHeading><CardContent className="flex-1 space-y-4"><div className="flex items-center justify-between gap-4"><label htmlFor="tunnel-switch" className="text-sm">Cloudflare Quick Tunnel</label><Unavailable t={t}><Switch id="tunnel-switch" checked={false} disabled aria-label={t('console.enableTunnel')} /></Unavailable></div><dl className="address-list"><div><dt>{t('console.local')}</dt><dd><code>127.0.0.1:8000</code></dd></div><div><dt>{t('dashboard.publicAddress')}</dt><dd>—</dd></div></dl></CardContent><CardFooter className="gap-2"><Unavailable t={t}><Button variant="outline" disabled><ArrowUpRight />{t('dashboard.open')}</Button></Unavailable><Unavailable t={t}><Button variant="ghost" disabled><Copy />{t('dashboard.copyLink')}</Button></Unavailable></CardFooter></Card>;
}

function DataPanel({ t, navigate }: { t: Translate; navigate: Navigate }) {
  return <Card data-tour="data"><PanelHeading icon={<Database />}>{t('console.data')}</PanelHeading><CardContent className="flex-1 space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-muted-foreground">{t('console.noProfiles')}</span><Button variant="ghost" size="sm" onClick={() => navigate('profiles')}>{t('nav.profiles')}<ArrowUpRight /></Button></div><dl className="address-list"><div><dt>{t('status.lastBackup')}</dt><dd>—</dd></div></dl></CardContent><CardFooter className="flex-wrap gap-2"><Button variant="outline" onClick={() => navigate('backups')}><Archive />{t('nav.backups')}</Button><Button variant="ghost" onClick={() => navigate('backups')}><Upload />{t('console.restore')}</Button></CardFooter><div className="r2-note"><Tooltip><TooltipTrigger asChild><button type="button" onClick={() => navigate('backups')}>{t('console.r2Recommended')}</button></TooltipTrigger><TooltipContent className="max-w-xs">{t('console.r2Help')}</TooltipContent></Tooltip></div></Card>;
}

function LogsPanel({ t, source, onSourceChange, navigate, expanded }: { t: Translate; source: string; onSourceChange: (value: string) => void; navigate: Navigate; expanded: boolean }) {
  return <Card data-tour="logs"><PanelHeading icon={<ScrollText />} action={!expanded ? <Button variant="ghost" size="sm" onClick={() => navigate('logs')}>{t('console.viewAll')}<ArrowUpRight /></Button> : undefined}>{t('console.liveLogs')}</PanelHeading><CardContent className="flex flex-1 flex-col gap-3"><Select value={source} onValueChange={onSourceChange}><SelectTrigger className="w-44" aria-label={t('console.logSource')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sillytavern">SillyTavern</SelectItem><SelectItem value="manager">Manager</SelectItem><SelectItem value="cloudflared">Cloudflare Tunnel</SelectItem><SelectItem value="installer">{t('console.installer')}</SelectItem><SelectItem value="backup">{t('nav.backups')}</SelectItem></SelectContent></Select><div className={`log-view ${expanded ? 'log-view-expanded' : ''}`} role="log" aria-label={t('console.liveLogs')}><span className="log-empty">{t('console.noLogs')}</span></div></CardContent></Card>;
}

function ResourcePanel({ page, t }: { page: Exclude<PageId, 'overview' | 'installations' | 'settings' | 'logs'>; t: Translate }) {
  const emptyMessage = { profiles: 'console.noProfiles', backups: 'dashboard.noBackup', metrics: 'console.noMetrics', config: 'console.noConfiguration' } as const;
  return <Card><CardContent className="resource-empty"><p>{t(emptyMessage[page])}</p>{page === 'profiles' ? <Unavailable t={t}><Button disabled><Plus />{t('console.createProfile')}</Button></Unavailable> : null}{page === 'backups' ? <Unavailable t={t}><Button disabled><Upload />{t('console.importZip')}</Button></Unavailable> : null}</CardContent>{page === 'backups' ? <CardFooter className="border-t pt-5 text-sm text-muted-foreground">{t('console.r2Recommended')}</CardFooter> : null}</Card>;
}

function SettingsPanel({ t, preferences, onChange }: { t: Translate; preferences: Preferences; onChange: (value: Partial<Preferences>) => void }) {
  return <div className="settings-stack"><Card><PanelHeading icon={<Settings2 />}>{t('console.appearance')}</PanelHeading><CardContent className="divide-y"><div className="setting-row"><span>{t('dashboard.theme')}</span><div className="flex gap-2" role="group" aria-label={t('dashboard.theme')}><Button variant={preferences.theme === 'light' ? 'secondary' : 'ghost'} aria-pressed={preferences.theme === 'light'} onClick={() => onChange({ theme: 'light' })}><Sun />{t('dashboard.light')}</Button><Button variant={preferences.theme === 'dark' ? 'secondary' : 'ghost'} aria-pressed={preferences.theme === 'dark'} onClick={() => onChange({ theme: 'dark' })}><Moon />{t('dashboard.dark')}</Button></div></div><div className="setting-row"><span>{t('dashboard.language')}</span><LanguageControl t={t} preferences={preferences} onChange={onChange} /></div></CardContent></Card><Card><PanelHeading icon={<Database />}>{t('console.sharingRequired')}</PanelHeading><CardContent className="space-y-3 text-sm text-muted-foreground"><p>{t('console.metadataNotice')}</p><p>{t('dashboard.neverCollected')}</p></CardContent></Card></div>;
}
