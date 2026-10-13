import { useEffect, useState } from 'react';
import { ExternalLink, Puzzle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, Badge, Button, Card, CardAction, CardContent, CardHeader, DataTable, EmptyState, initialQuery, type DataTableColumn, type DataTableLabels, type TableQuery } from '../../../packages/ui/src/index.js';
import { formatBytes, type ExtensionInfo, type ExtensionList } from '../../../packages/contracts/src/index.js';
import type { Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { apiFetch } from './session.js';

/**
 * The third-party extensions the active profile runs.
 *
 * Read-only for now: what is installed, where, whether it is switched off,
 * and whether git can update it. The list is read off the disk by the
 * manager, so it answers the same with SillyTavern stopped.
 */
export function ExtensionsPage({ t, locale, labels }: { t: Translate; locale: LocaleCode; labels: DataTableLabels }) {
  const [list, setList] = useState<ExtensionList | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 25, sort: 'name', direction: 'asc' }));
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/extensions', { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('extensions request failed');
        setList(await response.json() as ExtensionList);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  const dateFormat = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const scopeLabel = (item: ExtensionInfo) => t(item.scope === 'user' ? 'extensions.scopeUser' : 'extensions.scopeGlobal');
  const columns: DataTableColumn<ExtensionInfo>[] = [
    {
      id: 'name',
      header: t('common.name'),
      sortable: true,
      // Where it lives and its version ride under the name on a phone, where
      // there is no room for columns of their own.
      cell: (item) => <span className="grid min-w-0 justify-items-start gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium break-all" title={item.name}>{item.displayName}</span>
          {item.homePage ? <a href={item.homePage} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground" aria-label={`${t('extensions.homePage')}: ${item.displayName}`}><ExternalLink className="size-3.5" /></a> : null}
        </span>
        <span className="text-xs text-muted-foreground md:hidden">{[scopeLabel(item), item.version].filter(Boolean).join(' · ')}</span>
        <StatusChips t={t} item={item} />
      </span>,
    },
    { id: 'scope', header: t('extensions.columnScope'), sortable: true, showFrom: 'md', cell: (item) => <span className="whitespace-nowrap text-muted-foreground">{scopeLabel(item)}</span> },
    { id: 'version', header: t('extensions.columnVersion'), showFrom: 'md', cell: (item) => <span className="whitespace-nowrap text-muted-foreground" title={item.git?.commit}>{item.version ?? '-'}</span> },
    { id: 'updated', header: t('extensions.columnUpdated'), sortable: true, showFrom: 'sm', cell: (item) => <span className="whitespace-nowrap text-muted-foreground">{item.git?.committedAt ? dateFormat.format(new Date(item.git.committedAt)) : '-'}</span> },
    {
      id: 'size',
      header: t('extensions.columnSize'),
      sortable: true,
      align: 'end',
      showFrom: 'sm',
      cell: (item) => <span className="whitespace-nowrap text-muted-foreground" title={item.dependencyBytes > 0 ? t('extensions.sizeDetail', { size: formatBytes(item.bytes), dependencies: formatBytes(item.dependencyBytes) }) : undefined}>{formatBytes(item.bytes + item.dependencyBytes)}</span>,
    },
  ];

  return <div className="grid min-w-0 gap-4">
    <Card>
      <CardHeader className="grid-rows-[auto] items-center">
        <h2 className="panel-title"><Puzzle />{t('extensions.title')}</h2>
        <CardAction className="row-span-1 self-center"><Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button></CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {failed ? <Alert variant="destructive"><AlertDescription>{t('extensions.loadFailed')}</AlertDescription></Alert> : null}
        {list && !list.gitAvailable ? <Alert><AlertDescription>{t('extensions.gitMissing')}</AlertDescription></Alert> : null}
        <DataTable
          rows={list?.extensions ?? []}
          columns={columns}
          rowKey={(item) => `${item.scope}/${item.name}`}
          query={query}
          onQueryChange={setQuery}
          labels={labels}
          loading={list === null && !failed}
          searchText={(item) => `${item.displayName} ${item.name} ${item.author ?? ''}`}
          sortValue={(item, column) => column === 'name' ? item.displayName.toLowerCase()
            : column === 'scope' ? item.scope
              : column === 'updated' ? item.git?.committedAt ?? ''
                : column === 'size' ? item.bytes + item.dependencyBytes
                  : null}
          empty={<EmptyState icon={<Puzzle />} title={t('extensions.emptyTitle')} description={t('extensions.emptyDescription')} />}
        />
        <p className="text-xs text-muted-foreground">{t('extensions.scopeNote')}</p>
      </CardContent>
    </Card>
  </div>;
}

function StatusChips({ t, item }: { t: Translate; item: ExtensionInfo }) {
  const chips = [
    item.shadowed ? <Badge key="shadowed" variant="outline" title={t('extensions.shadowedHint')}>{t('extensions.shadowed')}</Badge> : null,
    !item.enabled ? <Badge key="disabled" variant="secondary">{t('extensions.disabled')}</Badge> : null,
    !item.hasGit ? <Badge key="git" variant="outline" title={t('extensions.noGitHint')}>{t('extensions.noGit')}</Badge> : null,
  ].filter(Boolean);
  return chips.length > 0 ? <span className="flex flex-wrap gap-1">{chips}</span> : null;
}
