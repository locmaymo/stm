import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { homePage } from './src/pages/home.mjs';
import { docsPage } from './src/pages/docs.mjs';
import { LOCALES, localeRoot } from './src/content/strings.mjs';
import { home } from './src/content/home.mjs';
import { docs } from './src/content/docs.mjs';

/**
 * Builds stm.phamloc.top into `dist/`.
 *
 * The site is static files and nothing else: no framework, no client-side
 * router, no runtime. This script renders one HTML file per page per language,
 * copies what is served verbatim, and stops. `deploy/oauth-relay` points
 * Wrangler at the directory it writes.
 *
 * The output is not committed. A generated file in the repository is a file
 * that will one day disagree with its source, and the only thing that ever
 * needs it is a deploy, which can run this first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '..', '..');
const dist = join(here, 'dist');

const pages = [
  { path: '/', render: homePage },
  { path: '/docs', render: docsPage },
];

await checkContentParity();
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Served exactly as written: the OAuth relay, the stylesheet, the two scripts
// and the headers file. Copied rather than rendered because none of it has a
// language and none of it has a template.
await cp(join(here, 'public'), dist, { recursive: true });

await copyBrandAssets();
await copyFonts();
await copyScreenshots();

let written = 0;
for (const locale of LOCALES) {
  for (const page of pages) {
    const target = join(dist, localeRoot(locale).slice(1), page.path === '/' ? '' : page.path.slice(1), 'index.html');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, page.render(locale), 'utf8');
    written += 1;
  }
}

console.log(`Site built: ${written} pages, ${await count(dist)} files in ${relative(repository, dist)}`);

/**
 * The panel's icons are the site's icons, produced by the same script from the
 * same artwork, so they are taken from where that script already put them
 * rather than kept a second time.
 */
async function copyBrandAssets() {
  const source = join(repository, 'apps', 'manager-panel', 'public');
  const assets = join(dist, 'assets');
  await mkdir(assets, { recursive: true });
  for (const name of ['brand-mark.png', 'favicon.ico', 'icon-512.png', 'apple-touch-icon.png']) {
    await cp(join(source, name), join(assets, name));
  }
}

/**
 * Two subsets of the panel's typeface, so the site is set in the same face as
 * the application it documents without carrying the other seven scripts that
 * package ships. Latin covers the English pages; Vietnamese covers the tones.
 */
async function copyFonts() {
  const source = join(repository, 'node_modules', '@fontsource-variable', 'noto-sans', 'files');
  const wanted = [
    ['noto-sans-latin-wght-normal.woff2', 'noto-sans-latin.woff2'],
    ['noto-sans-vietnamese-wght-normal.woff2', 'noto-sans-vietnamese.woff2'],
  ];
  for (const [from, to] of wanted) {
    try {
      await cp(join(source, from), join(dist, 'assets', to));
    } catch {
      throw new Error(`Missing ${from}. Run npm ci before building the site.`);
    }
  }
}

/** The README's screenshots, which are the panel's, in both languages. */
async function copyScreenshots() {
  const source = join(repository, '.github', 'screenshots');
  for (const locale of LOCALES) {
    await cp(join(source, locale), join(dist, 'img', locale), { recursive: true });
  }
}

/**
 * Refuse to build a page that says a different number of things in each
 * language.
 *
 * Both locales are rendered by one template, so a card missing from the
 * Vietnamese content would silently produce a shorter page rather than an
 * error. This is the same check the locale gate makes over the interface
 * strings, applied to the page content, and it runs before anything is
 * written so a bad build leaves the last good one in place.
 */
async function checkContentParity() {
  const problems = [];
  compare(home.en, home.vi, 'home', problems);
  compare(docs.en, docs.vi, 'docs', problems);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    throw new Error('The two languages do not carry the same page content.');
  }
}

function compare(english, vietnamese, path, problems) {
  if (Array.isArray(english)) {
    if (!Array.isArray(vietnamese) || english.length !== vietnamese.length) {
      problems.push(`site content: ${path} has ${english.length} entries in en and ${Array.isArray(vietnamese) ? vietnamese.length : 'none'} in vi`);
      return;
    }
    for (const [index, entry] of english.entries()) compare(entry, vietnamese[index], `${path}[${index}]`, problems);
    return;
  }
  if (english && typeof english === 'object') {
    if (!vietnamese || typeof vietnamese !== 'object') {
      problems.push(`site content: ${path} is missing from vi`);
      return;
    }
    for (const key of Object.keys(english)) compare(english[key], vietnamese[key], `${path}.${key}`, problems);
    for (const key of Object.keys(vietnamese)) {
      if (!(key in english)) problems.push(`site content: ${path}.${key} is in vi but not in en`);
    }
    return;
  }
  if (typeof vietnamese !== typeof english) {
    problems.push(`site content: ${path} is ${typeof english} in en and ${typeof vietnamese} in vi`);
  }
}

async function count(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await count(path) : (await stat(path)).isFile() ? 1 : 0;
  }
  return total;
}
