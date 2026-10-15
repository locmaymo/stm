import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLineText, type ConfigDocument, type ConfigUpdateInput, type Installation, type Profile } from '../../../packages/contracts/src/index.js';
import { LargeProfileLazyLoad, LAZY_LOAD_MIN_CHARACTERS, measureCharacters } from '../src/lazy-characters.js';

const installation = { id: 'install-1' } as Installation;

/** A profile with `count` small character cards, and a config that remembers its one setting. */
async function setup(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'stm-lazy-'));
  const userRoot = join(root, 'data', 'default-user');
  const characters = join(userRoot, 'characters');
  await mkdir(characters, { recursive: true });
  for (let index = 0; index < count; index += 1) await writeFile(join(characters, `card-${index}.png`), 'png');
  const profile = { id: 'profile-1', name: 'Main' } as Profile;
  let lazy = false;
  const updates: ConfigUpdateInput[] = [];
  const config = {
    read: async () => ({ settings: { lazyLoadCharacters: lazy } }) as unknown as ConfigDocument,
    update: async (_profile: Profile, _installation: Installation, input: ConfigUpdateInput) => {
      updates.push(input);
      if (input.settings?.lazyLoadCharacters !== undefined) lazy = input.settings.lazyLoadCharacters;
      return { settings: { lazyLoadCharacters: lazy } } as unknown as ConfigDocument;
    },
  };
  const lines: string[] = [];
  const loader = new LargeProfileLazyLoad({ file: join(root, 'state', 'lazy-characters.json'), config, userRoot: () => userRoot, logger: (line) => lines.push(logLineText(line)) });
  return { root, characters, profile, loader, updates, lines, setLazy: (value: boolean) => { lazy = value; } };
}

test('a profile with a great many characters has lazy loading turned on, once', async (t) => {
  const { root, profile, loader, updates, lines } = await setup(LAZY_LOAD_MIN_CHARACTERS);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  assert.equal(await loader.apply(profile, installation), true);
  assert.deepEqual(updates, [{ settings: { lazyLoadCharacters: true } }]);
  assert.ok(lines.some((line) => line.includes(`it has ${LAZY_LOAD_MIN_CHARACTERS} character cards`)), lines.join('\n'));
  assert.equal(await loader.apply(profile, installation), false);
  assert.equal(updates.length, 1);
});

test('turned off again by its owner, it stays off', async (t) => {
  const { root, profile, loader, updates, setLazy } = await setup(LAZY_LOAD_MIN_CHARACTERS + 50);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await loader.apply(profile, installation);
  setLazy(false);
  assert.equal(await loader.apply(profile, installation), false);
  assert.equal(updates.length, 1);
});

test('a profile that already had it on is remembered, so turning it off sticks', async (t) => {
  const { root, profile, loader, updates, setLazy } = await setup(LAZY_LOAD_MIN_CHARACTERS);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  setLazy(true);
  assert.equal(await loader.apply(profile, installation), false);
  setLazy(false);
  assert.equal(await loader.apply(profile, installation), false);
  assert.equal(updates.length, 0);
});

test('a small profile is left alone, and asked again once it has grown', async (t) => {
  const { root, characters, profile, loader, updates } = await setup(10);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  assert.equal(await loader.apply(profile, installation), false);
  assert.equal(updates.length, 0);
  for (let index = 10; index < LAZY_LOAD_MIN_CHARACTERS; index += 1) await writeFile(join(characters, `card-${index}.png`), 'png');
  assert.equal(await loader.apply(profile, installation), true);
});

test('a few very large cards count as a large profile too', async (t) => {
  const { root, characters, profile, loader } = await setup(3);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await truncate(join(characters, 'card-0.png'), 101 * 1024 * 1024);
  assert.equal(await loader.apply(profile, installation), true);
});

test('only the cards are counted, not the sprite folders beside them', async (t) => {
  const { root, characters } = await setup(2);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(characters, 'imported.json'), '{}');
  await mkdir(join(characters, 'card-0'), { recursive: true });
  await writeFile(join(characters, 'card-0', 'joy.png'), 'sprite');
  await writeFile(join(characters, 'notes.txt'), 'not a card');
  assert.equal((await measureCharacters(characters)).count, 3);
  assert.deepEqual(await measureCharacters(join(root, 'missing')), { count: 0, bytes: 0 });
});
