import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.tmp']);
const textExtensions = new Set([
  '.css', '.editorconfig', '.gitattributes', '.html', '.js', '.json', '.mjs', '.md',
  '.ps1', '.sh', '.toml', '.ts', '.tsx', '.yaml', '.yml',
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
  if (path.extname(filePath).toLowerCase() === '.json') {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push(`${relative}: invalid JSON (${error.message})`);
    }
  }
}

function flatten(value, prefix = '') {
  const result = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
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

function checkLocales() {
  const englishPath = path.join(root, 'packages', 'ui', 'locales', 'en.json');
  const vietnamesePath = path.join(root, 'packages', 'ui', 'locales', 'vi.json');
  if (!fs.existsSync(englishPath) || !fs.existsSync(vietnamesePath)) {
    failures.push('locale gate: both packages/ui/locales/en.json and vi.json are required');
    return;
  }
  const english = JSON.parse(fs.readFileSync(englishPath, 'utf8'));
  const vietnamese = JSON.parse(fs.readFileSync(vietnamesePath, 'utf8'));
  const en = flatten(english);
  const vi = flatten(vietnamese);
  const missing = [...en.keys()].filter((key) => !vi.has(key));
  const extra = [...vi.keys()].filter((key) => !en.has(key));
  if (missing.length) failures.push(`locale gate: vi.json is missing keys: ${missing.join(', ')}`);
  if (extra.length) failures.push(`locale gate: vi.json has non-canonical keys: ${extra.join(', ')}`);
  for (const key of en.keys()) {
    if (!vi.has(key)) continue;
    const enPlaceholders = JSON.stringify(placeholders(en.get(key)));
    const viPlaceholders = JSON.stringify(placeholders(vi.get(key)));
    if (enPlaceholders !== viPlaceholders) {
      failures.push(`locale gate: ICU placeholders differ for ${key}`);
    }
  }
}

for (const filePath of walk(root)) {
  if (isTextFile(filePath)) checkText(filePath);
}
checkLocales();

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Encoding, JSON, locale parity, ICU placeholder, and mojibake gates passed.');
}
