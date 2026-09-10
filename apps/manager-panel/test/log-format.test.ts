import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLogMessage } from '../src/log-format.js';

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
