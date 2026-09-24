import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.tmp']);
const textExtensions = new Set([
  '.css', '.editorconfig', '.gitattributes', '.html', '.js', '.json', '.mjs', '.md',
  '.ps1', '.sh', '.toml', '.ts', '.tsx', '.webmanifest', '.yaml', '.yml',
]);
const mojibakePattern = /(?:\u00c3[\u0080-\u00bf]|\u00c2[\u0080-\u00bf]|\u00e2(?:\u20ac|\u2122|\u0153)|\u00f0[\u0080-\u00bf]{1,2}|\u00d0[\u0080-\u00bf]|\u00d1[\u0080-\u00bf])/u;
const failures = [];

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...walk(path.join(directory, entry.name)));
      continue;
    }
    if (entry.isFile()) files.push(path.join(directory, entry.name));
  }
  return files;
}

function isTextFile(filePath) {
  const base = path.basename(filePath);
  return textExtensions.has(path.extname(base).toLowerCase()) ||
    base === '.editorconfig' || base === '.gitattributes';
}

function checkText(filePath) {
  const bytes = fs.readFileSync(filePath);
  const relative = path.relative(root, filePath);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    failures.push(`${relative}: UTF-8 BOM is forbidden`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    failures.push(`${relative}: invalid UTF-8 (${error.message})`);
    return;
  }
  if (text.includes('\uFFFD')) failures.push(`${relative}: contains U+FFFD`);
  if (text.normalize('NFC') !== text) failures.push(`${relative}: content is not NFC-normalized`);
  if (mojibakePattern.test(text)) {
    failures.push(`${relative}: possible mojibake marker detected`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json' || extension === '.webmanifest') {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push(`${relative}: invalid JSON (${error.message})`);
    }
  }
}

/**
 * Every leaf of a locale file, keyed by its path.
 *
 * Arrays are walked by index rather than stringified, because the legal texts
 * are arrays of paragraphs: a translation that merged two paragraphs into one
 * would otherwise pass a key comparison while no longer saying the same thing.
 * Walking them means the key set itself carries the paragraph count.
 */
function flatten(value, prefix = '') {
  const result = new Map();
  if (!value || typeof value !== 'object') return result;
  const entries = Array.isArray(value)
    ? value.map((child, index) => [String(index), child])
    : Object.entries(value);
  for (const [key, child] of entries) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') {
      for (const [nestedKey, nestedValue] of flatten(child, fullKey)) result.set(nestedKey, nestedValue);
    } else {
      result.set(fullKey, String(child));
    }
  }
  return result;
}

function placeholders(value) {
  return [...value.matchAll(/\{[^{}]+\}/g)].map((match) => match[0]).sort();
}

/** Every package that keeps an English/Vietnamese pair the gate holds in parity. */
const localeDirectories = [
  path.join('packages', 'ui', 'locales'),
  path.join('packages', 'legal', 'locales'),
];

/**
 * Keys written twice in the same object.
 *
 * `JSON.parse` keeps the last one and says nothing, so a key added a second
 * time silently replaces the first translation everywhere it was used - and
 * both locales can repeat it in step, which the parity check cannot see.
 */
function duplicateKeys(text) {
  const stack = [];
  const found = [];
  let lastKey = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.object && top.expectKey) {
        const name = JSON.parse(text.slice(index, end + 1));
        if (top.keys.has(name)) found.push([...top.path, name].join('.'));
        top.keys.add(name);
        top.expectKey = false;
        lastKey = name;
      }
      index = end;
    } else if (character === '{' || character === '[') {
      const parent = stack.at(-1);
      const path = parent ? (parent.object ? [...parent.path, lastKey] : parent.path) : [];
      stack.push({ object: character === '{', keys: new Set(), expectKey: character === '{', path });
    } else if (character === '}' || character === ']') {
      stack.pop();
    } else if (character === ',') {
      const top = stack.at(-1);
      if (top?.object) top.expectKey = true;
    }
  }
  return found;
}

function checkLocales(directory) {
  const englishPath = path.join(root, directory, 'en.json');
  const vietnamesePath = path.join(root, directory, 'vi.json');
  const label = directory.split(path.sep).join('/');
  if (!fs.existsSync(englishPath) || !fs.existsSync(vietnamesePath)) {
    failures.push(`locale gate: both ${label}/en.json and vi.json are required`);
    return;
  }
  for (const [name, file] of [['en.json', englishPath], ['vi.json', vietnamesePath]]) {
    const repeated = duplicateKeys(fs.readFileSync(file, 'utf8'));
    if (repeated.length) failures.push(`locale gate: ${label}/${name} repeats keys: ${repeated.join(', ')}`);
  }
  const english = JSON.parse(fs.readFileSync(englishPath, 'utf8'));
  const vietnamese = JSON.parse(fs.readFileSync(vietnamesePath, 'utf8'));
  const en = flatten(english);
  const vi = flatten(vietnamese);
  const missing = [...en.keys()].filter((key) => !vi.has(key));
  const extra = [...vi.keys()].filter((key) => !en.has(key));
  if (missing.length) failures.push(`locale gate: ${label}/vi.json is missing keys: ${missing.join(', ')}`);
  if (extra.length) failures.push(`locale gate: ${label}/vi.json has non-canonical keys: ${extra.join(', ')}`);
  for (const key of en.keys()) {
    if (!vi.has(key)) continue;
    const enPlaceholders = JSON.stringify(placeholders(en.get(key)));
    const viPlaceholders = JSON.stringify(placeholders(vi.get(key)));
    if (enPlaceholders !== viPlaceholders) {
      failures.push(`locale gate: ICU placeholders differ for ${label} ${key}`);
    }
  }
}

for (const filePath of walk(root)) {
  if (isTextFile(filePath)) checkText(filePath);
}
for (const directory of localeDirectories) checkLocales(directory);

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Encoding, JSON, locale parity, ICU placeholder, and mojibake gates passed.');
}
