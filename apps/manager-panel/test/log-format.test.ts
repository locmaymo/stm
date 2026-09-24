import assert from 'node:assert/strict';
import test from 'node:test';
import { foldForSearch, formatLogMessage, interpolate, translateLogEntry } from '../../../packages/contracts/src/index.js';

test('removes internal source and job id prefixes from visible log messages', () => {
  assert.equal(
    formatLogMessage('[installer:694e06ed-6378-4155-80b4-7dc62c2e3bcc] Installation ready'),
    'Installation ready',
  );
});

test('keeps normal messages unchanged', () => {
  assert.equal(formatLogMessage('SillyTavern is listening on IPv4: 127.0.0.1:8000'), 'SillyTavern is listening on IPv4: 127.0.0.1:8000');
  assert.equal(formatLogMessage('[ImageMetadata] Generated metadata'), '[ImageMetadata] Generated metadata');
  assert.equal(formatLogMessage('  indented content'), '  indented content');
  assert.equal(formatLogMessage('[installer]   indented output'), '  indented output');
});

test('translates a manager line into the reader language', () => {
  const catalog = { backup: { created: 'Đã tạo {name} ({files} tệp)' } };
  assert.equal(
    translateLogEntry(
      { id: 1, timestamp: '', source: 'backup', level: 'info', message: '[backup] created Default-2026.zip (12 files)', code: 'backup.created', params: { name: 'Default-2026.zip', files: 12 } },
      catalog,
    ),
    'Đã tạo Default-2026.zip (12 tệp)',
  );
});

test('shows third-party output exactly as the other program wrote it', () => {
  assert.equal(
    translateLogEntry({ id: 2, timestamp: '', source: 'sillytavern', level: 'info', message: '[sillytavern] Launching...' }, { backup: { created: 'x' } }),
    'Launching...',
  );
});

test('falls back to the English line when the catalog has no entry', () => {
  assert.equal(
    translateLogEntry({ id: 3, timestamp: '', source: 'manager', level: 'info', message: '[manager] opened http://127.0.0.1:7860', code: 'manager.browserOpened', params: { url: 'http://127.0.0.1:7860' } }, {}),
    'opened http://127.0.0.1:7860',
  );
});

test('leaves a placeholder in place when no value was sent for it', () => {
  assert.equal(interpolate('Restored {count} files to {profile}', { count: 4 }), 'Restored 4 files to {profile}');
});

test('a log search folds case, accents and how the letters were typed', () => {
  // Precomposed, as the catalogue is written, and decomposed, as some
  // Vietnamese keyboards type it, are the same word to a search.
  assert.equal(foldForSearch('Cổng ĐANG lắng nghe'), 'cong dang lang nghe');
  assert.equal(foldForSearch('co\u0302\u0309ng'), foldForSearch('c\u1ed5ng'));
  assert.ok(foldForSearch('Cổng truy cập SillyTavern').includes(foldForSearch('cong truy')));
});
