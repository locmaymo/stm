import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageTypeFor, isPlainFileName, previewImage, previewManifest } from '../src/preview.js';

async function userRoot(settings?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stm-preview-'));
  await mkdir(join(root, 'backgrounds'), { recursive: true });
  await mkdir(join(root, 'characters'), { recursive: true });
  await writeFile(join(root, 'backgrounds', 'landscape postapoc.jpg'), 'jpeg');
  await writeFile(join(root, 'backgrounds', 'bedroom clean.jpg'), 'jpeg');
  await writeFile(join(root, 'characters', 'Seraphina.png'), 'png');
  await writeFile(join(root, 'characters', 'notes.txt'), 'not an image');
  await writeFile(join(root, 'secret.json'), '{"token":"do not serve this"}');
  if (settings !== undefined) await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
  return root;
}

test('a name that is a path, in any spelling, is refused rather than resolved', () => {
  for (const name of ['../secret.json', '..\\secret.json', 'sub/dir.png', 'sub\\dir.png', 'C:secret.png', '..', '.', '']) {
    assert.equal(isPlainFileName(name), false, `${name} is a path`);
  }
  assert.equal(isPlainFileName('landscape postapoc.jpg'), true);
});

test('only files a browser will draw as an image have a type', () => {
  assert.equal(imageTypeFor('a.png'), 'image/png');
  assert.equal(imageTypeFor('a.JPG'), 'image/jpeg');
  assert.equal(imageTypeFor('settings.json'), null);
  assert.equal(imageTypeFor('a.svg'), null, 'SVG can carry script, so it is not offered');
});

test('the background is the one SillyTavern is set to', async () => {
  const root = await userRoot({ background: { name: 'landscape postapoc.jpg' }, power_user: { theme: 'Cappuccino', main_text_color: 'rgba(169, 201, 239, 1)', chat_width: 50 } });
  const manifest = await previewManifest(root);
  assert.equal(manifest.background, 'landscape postapoc.jpg');
  assert.equal(manifest.theme?.text, 'rgba(169, 201, 239, 1)');
  assert.equal(manifest.theme?.chatWidth, 50);
  assert.equal(manifest.theme?.name, 'Cappuccino', 'and the theme it is wearing');
});

test('a missing or unusable setting falls back to a background that is on disk', async () => {
  assert.ok((await previewManifest(await userRoot())).background);
  assert.ok((await previewManifest(await userRoot({ background: { name: '../secret.json' } }))).background !== '../secret.json');
  assert.ok((await previewManifest(await userRoot({ background: 'landscape postapoc.jpg' }))).background);
});

test('an image is served from the two named directories and from nowhere else', async () => {
  const root = await userRoot({ background: { name: 'landscape postapoc.jpg' } });
  assert.ok(await previewImage(root, 'background', 'landscape postapoc.jpg'));
  assert.ok(await previewImage(root, 'avatar', 'Seraphina.png'));
  // The character is not reachable through the background directory, the
  // settings file is not reachable at all, and neither is anything above.
  assert.equal(await previewImage(root, 'background', 'Seraphina.png'), null);
  assert.equal(await previewImage(root, 'avatar', '../settings.json'), null);
  assert.equal(await previewImage(root, 'avatar', '..\\secret.json'), null);
  assert.equal(await previewImage(root, 'avatar', 'notes.txt'), null);
});

test('the recent rows are the characters last talked to, and carry no chat content', async () => {
  const root = await userRoot();
  for (const [character, at] of [['Seraphina', 3], ['Jensen', 1], ['Gojo', 2], ['Nobody', 0]] as const) {
    await mkdir(join(root, 'chats', character), { recursive: true });
    if (at === 0) continue;
    const file = join(root, 'chats', character, `${character} - chat.jsonl`);
    await writeFile(file, '{"mes":"a private conversation"}\n');
    await utimes(file, new Date(at * 60_000), new Date(at * 60_000));
  }
  const { recent } = await previewManifest(root);
  assert.deepEqual(recent.map((row) => row.name), ['Seraphina', 'Gojo', 'Jensen'], 'newest first, and a character with no chat is not recent');
  assert.equal(recent[0]?.avatar, 'Seraphina.png', 'with the card SillyTavern names after them');
  assert.equal(recent[1]?.avatar, null, 'or nothing when there is no card');
  const serialised = JSON.stringify(recent);
  assert.doesNotMatch(serialised, /private conversation/u, 'nothing inside a chat file is read');
});

test('an empty profile answers with nothing rather than failing', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'stm-preview-empty-'));
  assert.deepEqual(await previewManifest(empty), { background: null, theme: null, recent: [] });
  assert.equal(await previewImage(empty, 'background', 'anything.png'), null);
});
