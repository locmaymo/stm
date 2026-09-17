import en from '../locales/en.json' with { type: 'json' };
import vi from '../locales/vi.json' with { type: 'json' };

/**
 * The project's legal text, in one place, in both languages.
 *
 * The panel and the website say the same thing because they read the same
 * file. A notice that lives in two hand-written copies drifts the first time
 * one of them is edited, and a disclaimer that disagrees with itself is worse
 * than no disclaimer at all - so there is exactly one source, the parity gate
 * checks that the two locales have the same documents, the same sections in
 * the same order and the same number of paragraphs, and everything that
 * renders it is a view.
 *
 * The text ships inside the application rather than being fetched, because the
 * first screen anyone meets is the one that asks them to accept it, and that
 * screen is often the first thing an installation does on a machine with no
 * route to the internet yet.
 */

export type LegalLocale = 'en' | 'vi';

/**
 * Who published this, where it lives, and which revision is in force.
 *
 * The same in both languages - the parity test holds the date and the revision
 * identical - so anything that needs only the revision can read it without
 * choosing a language first. The server records it against an acceptance, and
 * the panel and the website print it under the text it belongs to.
 */
export const LEGAL_META: LegalMeta = en.meta;

/** The four documents, in the order they are offered. */
export const LEGAL_DOCUMENT_IDS = ['terms', 'disclaimer', 'privacy', 'notices'] as const;
export type LegalDocumentId = typeof LEGAL_DOCUMENT_IDS[number];

export interface LegalSection {
  /** Stable across locales and across revisions, so it can be linked to. */
  readonly id: string;
  readonly heading: string;
  readonly body: readonly string[];
}

export interface LegalDocument {
  readonly id: LegalDocumentId;
  readonly title: string;
  /** What to call it where there is no room for the full title. */
  readonly short: string;
  /** One sentence, read before the document is opened. */
  readonly summary: string;
  readonly sections: readonly LegalSection[];
}

export interface LegalMeta {
  /** ISO date the current revision took effect. */
  readonly effective: string;
  readonly revision: string;
  readonly author: string;
  readonly project: string;
  readonly repository: string;
  readonly issues: string;
  readonly security: string;
  readonly site: string;
}

export interface LegalLabels {
  readonly effectiveFrom: string;
  readonly revisionLabel: string;
  readonly readingTime: string;
}

export interface LegalBundle {
  readonly locale: LegalLocale;
  readonly meta: LegalMeta;
  readonly labels: LegalLabels;
  readonly documents: readonly LegalDocument[];
}

interface RawSection {
  readonly heading: string;
  readonly body: readonly string[];
}

interface RawDocument {
  readonly title: string;
  readonly short: string;
  readonly summary: string;
  readonly sections: Readonly<Record<string, RawSection>>;
}

interface RawBundle {
  readonly meta: LegalMeta;
  readonly labels: LegalLabels;
  readonly documents: Readonly<Record<string, RawDocument>>;
}

const raw: Readonly<Record<LegalLocale, RawBundle>> = {
  en: en as unknown as RawBundle,
  vi: vi as unknown as RawBundle,
};

function toDocument(id: LegalDocumentId, document: RawDocument): LegalDocument {
  return {
    id,
    title: document.title,
    short: document.short,
    summary: document.summary,
    sections: Object.entries(document.sections).map(([sectionId, section]) => ({
      id: sectionId,
      heading: section.heading,
      body: [...section.body],
    })),
  };
}

/** Every document for one language, in reading order. */
export function legalBundle(locale: LegalLocale): LegalBundle {
  const bundle = raw[locale];
  return {
    locale,
    meta: bundle.meta,
    labels: bundle.labels,
    documents: LEGAL_DOCUMENT_IDS.map((id) => {
      const document = bundle.documents[id];
      if (!document) throw new Error(`The ${locale} legal bundle is missing the ${id} document`);
      return toDocument(id, document);
    }),
  };
}

/** One document, for a page or a dialog tab that shows a single one. */
export function legalDocument(locale: LegalLocale, id: LegalDocumentId): LegalDocument {
  const document = legalBundle(locale).documents.find((candidate) => candidate.id === id);
  if (!document) throw new Error(`The ${locale} legal bundle is missing the ${id} document`);
  return document;
}

/**
 * Roughly how long a document takes to read, in whole minutes, never below one.
 *
 * A reader deciding whether to open a wall of legal text is owed an honest
 * estimate of what they are in for. 200 words a minute is the conventional
 * figure for prose read carefully; Vietnamese is counted the same way, since
 * both locales are written in words separated by spaces.
 */
export function legalReadingMinutes(document: LegalDocument): number {
  const words = document.sections
    .flatMap((section) => [section.heading, ...section.body])
    .reduce((total, text) => total + text.split(/\s+/u).filter(Boolean).length, 0);
  return Math.max(1, Math.round(words / 200));
}
