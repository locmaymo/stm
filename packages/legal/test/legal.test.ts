import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../locales/en.json' with { type: 'json' };
import vi from '../locales/vi.json' with { type: 'json' };
import { LEGAL_DOCUMENT_IDS, legalBundle, legalDocument, legalReadingMinutes } from '../src/index.js';

const locales = ['en', 'vi'] as const;

test('every document listed is present in both languages', () => {
  for (const locale of locales) {
    const bundle = legalBundle(locale);
    assert.deepEqual(bundle.documents.map((document) => document.id), [...LEGAL_DOCUMENT_IDS]);
    for (const document of bundle.documents) {
      assert.ok(document.title.length > 0, `${locale}/${document.id} has no title`);
      assert.ok(document.summary.length > 0, `${locale}/${document.id} has no summary`);
      assert.ok(document.sections.length > 0, `${locale}/${document.id} has no sections`);
    }
  }
});

test('the two languages carry the same sections in the same order', () => {
  const english = legalBundle('en');
  const vietnamese = legalBundle('vi');
  for (const [index, document] of english.documents.entries()) {
    const translated = vietnamese.documents.at(index);
    if (!translated) throw new Error(`vi is missing document ${document.id}`);
    assert.deepEqual(
      translated.sections.map((section) => section.id),
      document.sections.map((section) => section.id),
      `section ids differ in ${document.id}`,
    );
    for (const [position, section] of document.sections.entries()) {
      const counterpart = translated.sections.at(position);
      if (!counterpart) throw new Error(`vi is missing ${document.id}.${section.id}`);
      // A translated document that dropped or merged a paragraph no longer
      // says the same thing, which is the one failure mode that matters here.
      assert.equal(
        counterpart.body.length,
        section.body.length,
        `${document.id}.${section.id} has ${counterpart.body.length} paragraphs in vi and ${section.body.length} in en`,
      );
    }
  }
});

test('no section is left empty or untranslated', () => {
  for (const locale of locales) {
    for (const document of legalBundle(locale).documents) {
      for (const section of document.sections) {
        assert.ok(section.heading.trim().length > 0, `${locale}/${document.id}.${section.id} has no heading`);
        for (const [index, paragraph] of section.body.entries()) {
          assert.ok(paragraph.trim().length > 0, `${locale}/${document.id}.${section.id}[${index}] is empty`);
        }
      }
    }
  }
});

test('both languages agree on the revision and the date it took effect', () => {
  assert.equal(en.meta.effective, vi.meta.effective);
  assert.equal(en.meta.revision, vi.meta.revision);
  assert.match(en.meta.effective, /^\d{4}-\d{2}-\d{2}$/u);
});

test('a document can be read on its own, and reports how long it takes', () => {
  const terms = legalDocument('vi', 'terms');
  assert.equal(terms.id, 'terms');
  assert.ok(legalReadingMinutes(terms) >= 1);
});
