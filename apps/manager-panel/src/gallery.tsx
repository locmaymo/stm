import { useState } from 'react';
import {
  Archive, Cloud, Download, Ellipsis, Info, Plus, RotateCcw, Trash2, TriangleAlert,
} from 'lucide-react';
import {
  Alert, AlertDescription, AlertTitle,
  BrandLockup, Button, Card, CardContent, CardHeader,
  Checkbox, CloudflareMark, ConfirmDialog,
  DataTable, type DataTableColumn,
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DockerMark, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  EmptyState, Field, GithubMark, Input, Label, PasswordInput, Progress, R2Mark,
  StatusHero,
  Tabs, TabsContent, TabsList, TabsTrigger, Toaster, initialQuery, useToast, type TableQuery,
} from '../../../packages/ui/src/index.js';

/**
 * Every component in one place, on one page.
 *
 * This is a workbench, not a destination: it is how a primitive gets looked at
 * in both themes, at phone and desktop width, before any page depends on it.
 * It is reachable only at `#gallery`, is never linked from the navigation, and
 * holds no real data and no real API call.
 */

interface Row {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly source: 'created' | 'uploaded';
}

const sampleRows: readonly Row[] = Array.from({ length: 23 }, (_unused, index) => ({
  id: `row-${index}`,
  name: `Backup ${index + 1}`,
  createdAt: new Date(Date.UTC(2026, 2, 1 + index, 9, 30)).toISOString(),
  sizeBytes: (index + 1) * 7_500_000,
  source: index % 3 === 0 ? 'uploaded' : 'created',
}));

const tableLabels = {
  search: 'Search',
  perPage: 'Rows per page',
  count: (shown: number, total: number) => `Showing ${shown} of ${total}`,
  sortAscending: 'Sort ascending',
  sortDescending: 'Sort descending',
  navigation: 'Pagination',
  previous: 'Previous page',
  next: 'Next page',
  page: (page: number, of: number) => `Page ${page} of ${of}`,
};

export function Gallery() {
  return (
    <Toaster>
      <GalleryBody />
    </Toaster>
  );
}

function GalleryBody() {
  const { toast } = useToast();
  const [query, setQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 5, sort: 'createdAt', direction: 'desc' }));
  const [serverQuery, setServerQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 5 }));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>('This name is already taken.');

  const columns: readonly DataTableColumn<Row>[] = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      sortable: true,
      showFrom: 'sm',
      cell: (row) => new Date(row.createdAt).toLocaleString(),
    },
    {
      id: 'size',
      header: 'Size',
      sortable: true,
      align: 'end',
      showFrom: 'md',
      cell: (row) => `${(row.sizeBytes / 1_000_000).toFixed(1)} MB`,
    },
    {
      id: 'actions',
      header: '',
      align: 'end',
      headClassName: 'w-12',
      cell: () => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem><Download />Download</DropdownMenuItem>
            <DropdownMenuItem><RotateCcw />Restore</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive"><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  // A server-backed table is given one page of rows plus the total, and the
  // controls behave identically. Paged here in the browser only to fake it.
  const serverPage = sampleRows.slice((serverQuery.page - 1) * serverQuery.pageSize, serverQuery.page * serverQuery.pageSize);

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-4">
        <BrandLockup label="Component gallery" size={32} />
        <div className="flex items-center gap-2">
          <CloudflareMark />
          <R2Mark />
          <DockerMark />
          <GithubMark />
        </div>
      </header>

      <Section title="Status hero">
        {/* Every state the overview can open in, which is otherwise only
            reachable by installing SillyTavern and stopping it. */}
        <div className="grid gap-3">
          <StatusHero
            tone="online"
            title="SillyTavern is running"
            detail="Shared at https://plain-otter-quietly.trycloudflare.com"
            actions={<><Button variant="outline">Open</Button><Button variant="outline">Stop</Button></>}
          />
          <StatusHero tone="offline" title="SillyTavern is stopped" detail="1.18.0" actions={<Button>Start</Button>} />
          <StatusHero tone="working" title="Installing SillyTavern" detail="Downloading the release · 62%" progress={62} />
          <StatusHero tone="attention" title="SillyTavern could not start" detail="Port 8000 is already in use" actions={<Button>Start</Button>} />
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive"><Trash2 />Delete</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm"><Plus />Small</Button>
          <Button size="icon" aria-label="Icon"><Plus /></Button>
        </div>
      </Section>

      <Section title="Feedback">
        <div className="grid gap-3">
          <Alert><Info /><AlertTitle>Default</AlertTitle><AlertDescription>Something worth knowing.</AlertDescription></Alert>
          <Alert variant="success"><Info /><AlertTitle>Success</AlertTitle></Alert>
          <Alert variant="attention"><TriangleAlert /><AlertTitle>Attention</AlertTitle><AlertDescription>Sharing needs a password first.</AlertDescription></Alert>
          <Alert variant="destructive"><TriangleAlert /><AlertTitle>Could not reach the bucket</AlertTitle><AlertDescription>Check the endpoint and try again.</AlertDescription></Alert>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => toast({ title: 'Saved' })}>Toast</Button>
            <Button variant="outline" size="sm" onClick={() => toast({ title: 'Backup finished', description: '182 files, 340 MB', tone: 'success' })}>Success</Button>
            <Button variant="outline" size="sm" onClick={() => toast({ title: 'Sharing needs a password', tone: 'attention' })}>Attention</Button>
            <Button variant="outline" size="sm" onClick={() => toast({ title: 'Upload failed', description: 'The connection dropped at 62%.', tone: 'destructive', action: { label: 'Try again', onSelect: () => toast({ title: 'Retrying' }) } })}>Error</Button>
          </div>
          <div className="grid gap-2">
            <Progress value={38} />
            <Progress value={72} tone="success" />
            <Progress value={91} tone="attention" />
            <Progress />
          </div>
        </div>
      </Section>

      <Section title="Forms">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Profile name" hint="Shown in the profile switcher.">
            <Input placeholder="Default" />
          </Field>
          <Field label="Manager password" required error={error}>
            <PasswordInput revealLabel="Show password" hideLabel="Hide password" onChange={() => setError(null)} />
          </Field>
          <Label className="col-span-full items-start gap-2.5">
            <Checkbox checked={accepted} onCheckedChange={(value) => setAccepted(value === true)} />
            <span className="text-sm font-normal">I understand this replaces everything in the profile.</span>
          </Label>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="local">
          <TabsList>
            <TabsTrigger value="local"><Archive />Local</TabsTrigger>
            <TabsTrigger value="cloud"><Cloud />Cloudflare R2</TabsTrigger>
          </TabsList>
          <TabsContent value="local"><p className="text-sm text-muted-foreground">Backups stored on this machine.</p></TabsContent>
          <TabsContent value="cloud"><p className="text-sm text-muted-foreground">Recovery points kept off this machine.</p></TabsContent>
        </Tabs>
      </Section>

      <Section title="Table — rows the browser holds">
        <DataTable
          rows={sampleRows}
          columns={columns}
          rowKey={(row) => row.id}
          query={query}
          onQueryChange={setQuery}
          labels={tableLabels}
          searchText={(row) => `${row.name} ${row.source}`}
          sortValue={(row, column) => (column === 'name' ? row.name : column === 'size' ? row.sizeBytes : row.createdAt)}
          pageSizes={[5, 10, 25]}
          toolbar={<Button size="sm" className="ml-auto"><Plus />New backup</Button>}
        />
      </Section>

      <Section title="Table — one page from the server">
        <DataTable
          rows={serverPage}
          total={sampleRows.length}
          columns={columns}
          rowKey={(row) => row.id}
          query={serverQuery}
          onQueryChange={setServerQuery}
          labels={tableLabels}
          pageSizes={[5, 10, 25]}
        />
      </Section>

      <Section title="Table — loading and empty">
        <DataTable rows={[]} columns={columns} rowKey={(row) => row.id} query={initialQuery()} onQueryChange={() => undefined} labels={tableLabels} loading />
        <DataTable
          rows={[]}
          columns={columns}
          rowKey={(row) => row.id}
          query={initialQuery()}
          onQueryChange={() => undefined}
          labels={tableLabels}
          empty={<EmptyState icon={<Archive />} title="No backup yet" action={<Button size="sm"><Plus />Back up now</Button>} />}
        />
      </Section>

      <Section title="Dialogs">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}><Trash2 />Delete backup</Button>
        </div>
      </Section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Cloudflare R2</DialogTitle>
            <DialogDescription>Keep a copy of your data off this machine.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field label="Bucket"><Input placeholder="sillytavern" /></Field>
            <Field label="Access key"><Input autoComplete="off" /></Field>
            <Field label="Secret key"><PasswordInput revealLabel="Show" hideLabel="Hide" autoComplete="new-password" /></Field>
            <p className="text-sm text-muted-foreground">A long body scrolls inside the dialog rather than off the bottom of the screen.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => { setDialogOpen(false); toast({ title: 'Connected', tone: 'success' }); }}>Connect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this backup?"
        description="Backup 7 will be removed from this machine. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        onConfirm={() => { toast({ title: 'Backup deleted', tone: 'success' }); }}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><h2 className="text-sm font-semibold">{title}</h2></CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}
