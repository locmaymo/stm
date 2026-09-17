import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, Scale } from 'lucide-react';
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, GithubMark, Tabs, TabsContent, TabsList, TabsTrigger,
} from '../../../packages/ui/src/index.js';
import {
  legalBundle, legalReadingMinutes, LEGAL_META, type LegalDocument, type LegalDocumentId,
} from '../../../packages/legal/src/index.js';
import type { Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';

/**
 * The project's terms, disclaimer and notices, where they are agreed to.
 *
 * The text is compiled into the panel rather than fetched, because the screen
 * that asks somebody to accept it is the first screen an installation ever
 * shows - often on a machine that has just been set up, behind a firewall, or
 * on a phone's hotspot with nothing routed yet. A notice nobody can read is
 * not a notice, and a checkbox above an unreachable link is worse than none.
 *
 * It follows the reader's language because it is the same decision they made
 * in the corner of the screen a moment ago; nobody should have to accept
 * terms in a language they did not choose.
 */

export const LEGAL_REVISION = LEGAL_META;

export interface LegalDialogProps {
  readonly t: Translate;
  readonly locale: LocaleCode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Which document to open on. Changing it while open moves to that tab. */
  readonly document: LegalDocumentId;
  readonly onDocumentChange: (document: LegalDocumentId) => void;
}

export function LegalDialog({ t, locale, open, onOpenChange, document, onDocumentChange }: LegalDialogProps) {
  const bundle = legalBundle(locale);
  const body = useRef<HTMLDivElement>(null);
  // Every tab is a different document, so it starts at its own beginning. A
  // reader who scrolled to the end of the terms and then opened the privacy
  // notice was dropped into the middle of a sentence.
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [document, open]);

  const current = bundle.documents.find((candidate) => candidate.id === document) ?? bundle.documents[0];
  if (!current) return null;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Scale className="size-4 shrink-0 text-muted-foreground" />{t('legal.title')}</DialogTitle>
        <DialogDescription>
          {t('legal.effective', { date: formatDate(bundle.meta.effective, locale), revision: bundle.meta.revision })}
        </DialogDescription>
      </DialogHeader>
      <DialogBody ref={body} className="p-0">
        <Tabs
          value={current.id}
          onValueChange={(value) => onDocumentChange(value as LegalDocumentId)}
          className="gap-0"
        >
          {/* Sticky, so the four documents stay reachable while one of them is
              being scrolled through. The dialog body is the scroller, which is
              why its own padding was removed and put back on the pieces. */}
          <div className="sticky top-0 z-10 border-b bg-popover px-5 py-3">
            <TabsList aria-label={t('legal.documents')}>
              {bundle.documents.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>{entry.short}</TabsTrigger>
              ))}
            </TabsList>
          </div>
          {bundle.documents.map((entry) => (
            <TabsContent key={entry.id} value={entry.id} className="px-5 pt-5 pb-6">
              <LegalBody document={entry} t={t} />
            </TabsContent>
          ))}
        </Tabs>
      </DialogBody>
      <DialogFooter className="sm:justify-between">
        <a
          className="legal-source"
          // The site keeps Vietnamese under `/vi`, so a reader following this
          // arrives in the language they are already reading rather than in
          // English with a switch to find.
          href={`${bundle.meta.site}${locale === 'en' ? '' : `/${locale}`}/${current.id}`}
          target="_blank"
          rel="noreferrer noopener"
        >{t('legal.online')}<ArrowUpRight className="size-3.5" /></a>
        <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function LegalBody({ document, t }: { document: LegalDocument; t: Translate }) {
  return <article className="legal-prose">
    <header>
      <h3>{document.title}</h3>
      <p className="legal-summary">{document.summary}</p>
      <p className="legal-meta">{t('legal.readingTime', { minutes: legalReadingMinutes(document) })}</p>
    </header>
    {document.sections.map((section, index) => (
      <section key={section.id} aria-labelledby={`legal-${document.id}-${section.id}`}>
        <h4 id={`legal-${document.id}-${section.id}`}>
          <span aria-hidden="true">{index + 1}.</span>{section.heading}
        </h4>
        {section.body.map((paragraph, position) => <p key={position}>{paragraph}</p>)}
      </section>
    ))}
  </article>;
}

/** The date a revision took effect, written the way the reader writes dates. */
function formatDate(iso: string, locale: LocaleCode): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(date);
  } catch {
    return iso;
  }
}

export interface LegalCreditProps {
  readonly t: Translate;
  /** Extra content after the repository link, such as a legal-text button. */
  readonly children?: ReactNode;
}

/**
 * Where the software came from, said once, where anyone can see it.
 *
 * Free software that names its own source is the normal courtesy, and it is
 * also the practical answer to "which version is this?" when somebody reports
 * a fault. The version is the panel's own, baked in at build time, so it
 * describes the interface being looked at rather than a number a server
 * remembered from an earlier install.
 */
export function LegalCredit({ t, children }: LegalCreditProps) {
  return <div className="project-credit">
    <a href={LEGAL_REVISION.repository} target="_blank" rel="noreferrer noopener">
      <GithubMark className="size-4" aria-hidden="true" />
      <span>locmaymo/stm</span>
    </a>
    <span aria-hidden="true">·</span>
    <span className="project-version" title={t('legal.version', { version: __STM_VERSION__ })}>v{__STM_VERSION__}</span>
    {children}
  </div>;
}
