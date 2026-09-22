import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseWatch, compareVersions, releaseName, releaseNotes, versionOf } from '../src/manager-release.js';

interface FakeRelease {
  readonly tag_name: string;
  readonly name?: string;
  readonly body?: string;
  readonly html_url?: string;
  readonly published_at?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
}

/**
 * GitHub, answering with whatever a test hands it, and counting the asks.
 *
 * The count is half of what is being measured here: the point of the watcher
 * is that a console asking every hour does not become an hourly request to an
 * API that rate limits by address.
 */
function fakeGitHub(releases: readonly FakeRelease[] | (() => readonly FakeRelease[] | Error)): { fetch: typeof globalThis.fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const answer = typeof releases === 'function' ? releases() : releases;
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

test('a release newer than the running version is reported with its notes', async () => {
  const github = fakeGitHub([
    { tag_name: 'v0.3.0', name: 'Backups that survive a wipe', body: '## What is new\n\n- A card that says what changed\n', html_url: 'https://example.invalid/v0.3.0', published_at: '2026-09-20T10:00:00Z' },
    { tag_name: 'v0.2.0', body: 'older' },
  ]);
  const watch = new ReleaseWatch({ version: '0.2.0', fetch: github.fetch });
  await watch.check();
  const status = watch.status();
  assert.equal(status.version, '0.2.0');
  assert.equal(status.update?.version, '0.3.0');
  assert.equal(status.update?.name, 'Backups that survive a wipe');
  assert.equal(status.update?.url, 'https://example.invalid/v0.3.0');
  assert.equal(status.update?.notes, 'What is new\n\n- A card that says what changed');
  assert.ok(status.checkedAt);
});

test('the version already running is not offered to itself', async () => {
  const github = fakeGitHub([{ tag_name: 'v0.3.0' }]);
  const watch = new ReleaseWatch({ version: '0.3.0', fetch: github.fetch });
  await watch.check();
  assert.equal(watch.status().update, null);
  // It was asked, and the answer was "nothing to say" rather than "not asked".
  assert.ok(watch.status().checkedAt);
});

test('a build ahead of every release is not told to go back to one', async () => {
  const github = fakeGitHub([{ tag_name: 'v0.2.0' }]);
  const watch = new ReleaseWatch({ version: '0.3.0', fetch: github.fetch });
  await watch.check();
  assert.equal(watch.status().update, null);
});

test('drafts and pre-releases are not releases', async () => {
  const github = fakeGitHub([
    { tag_name: 'v0.4.0', draft: true },
    { tag_name: 'v0.3.1', prerelease: true },
    { tag_name: 'v0.3.0' },
  ]);
  const watch = new ReleaseWatch({ version: '0.2.0', fetch: github.fetch });
  await watch.check();
  assert.equal(watch.status().update?.version, '0.3.0');
});

test('the newest release is the highest version, not the one listed first', async () => {
  const github = fakeGitHub([
    { tag_name: 'v0.2.9' },
    { tag_name: 'v0.10.0' },
  ]);
  const watch = new ReleaseWatch({ version: '0.2.0', fetch: github.fetch });
  await watch.check();
  assert.equal(watch.status().update?.version, '0.10.0');
});

test('an answer is kept rather than asked for again on every check', async () => {
  const github = fakeGitHub([{ tag_name: 'v0.3.0' }]);
  const watch = new ReleaseWatch({ version: '0.2.0', fetch: github.fetch, freshForMs: 60_000 });
  await watch.check();
  await watch.check();
  await watch.check();
  assert.equal(github.calls(), 1);
});

test('a stale answer is replaced, and a forced check ignores the clock', async () => {
  let current = '0.3.0';
  const github = fakeGitHub(() => [{ tag_name: `v${current}` }]);
  let clock = 1_000;
  const watch = new ReleaseWatch({ version: '0.2.0', fetch: github.fetch, freshForMs: 10_000, now: () => new Date(clock) });
  await watch.check();
  assert.equal(watch.status().update?.version, '0.3.0');
  current = '0.4.0';
  clock += 5_000;
  await watch.check();
  assert.equal(watch.status().update?.version, '0.3.0', 'a fresh answer is not thrown away');
  clock += 6_000;
  await watch.check();
  assert.equal(watch.status().update?.version, '0.4.0');
  current = '0.5.0';
  await watch.check({ force: true });
  assert.equal(watch.status().update?.version, '0.5.0');
});

test('a refusal is reported once and is not retried until the clock says so', async () => {
  const lines: string[] = [];
  const github = fakeGitHub(() => new Error('GitHub is not answering'));
  let clock = 1_000;
  const watch = new ReleaseWatch({
    version: '0.2.0',
    fetch: github.fetch,
    now: () => new Date(clock),
    retryAfterMs: 10_000,
    logger: (line) => { lines.push(typeof line === 'string' ? line : line.message); },
  });
  await watch.check();
  await watch.check();
  assert.equal(github.calls(), 1, 'the second ask is inside the wait');
  assert.equal(watch.status().checkedAt, null, 'nothing was learned, so nothing is claimed');
  clock += 11_000;
  await watch.check();
  assert.equal(github.calls(), 2);
  assert.equal(lines.length, 1, 'the same standing failure is said once');
});

test('a repository with no releases at all is not a failure', async () => {
  const github = fakeGitHub([]);
  const watch = new ReleaseWatch({ version: '0.2.0', fetch: github.fetch });
  await watch.check();
  assert.equal(watch.status().update, null);
  assert.ok(watch.status().checkedAt);
});

test('versions order the way a reader reads them', () => {
  assert.equal(compareVersions('0.19.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
  assert.equal(versionOf('v1.2.3'), '1.2.3');
  assert.equal(versionOf('1.2.3'), '1.2.3');
});

test('release notes lose their markup and their generated trailer', () => {
  const notes = releaseNotes([
    '## Highlights',
    '',
    '* **Backups** that survive a wipe, see [the docs](https://example.invalid/docs)',
    '* `--flag` is gone',
    '',
    '**Full Changelog**: https://example.invalid/compare/v0.2.0...v0.3.0',
  ].join('\n'));
  assert.equal(notes, 'Highlights\n\n- Backups that survive a wipe, see the docs\n- --flag is gone');
});

test('a release named after its own tag is not given a title that repeats it', () => {
  assert.equal(releaseName('v0.2.0', 'v0.2.0'), null);
  assert.equal(releaseName('0.2.0', 'v0.2.0'), null);
  assert.equal(releaseName('  ', 'v0.2.0'), null);
  assert.equal(releaseName('Backups that survive a wipe', 'v0.2.0'), 'Backups that survive a wipe');
});

test('the addresses in a generated changelog are dropped, and the words kept', () => {
  const notes = releaseNotes([
    "## What's Changed",
    '* Run verify on every pull request by @locmaymo in https://github.com/locmaymo/stm/pull/2',
    '* Cloudflare R2 sign-in and backups by @locmaymo in https://github.com/locmaymo/stm/pull/6',
    '',
    'New Contributors',
    '* @locmaymo made their first contribution in https://github.com/locmaymo/stm/pull/2',
    '',
    'Read more at https://stm.locmaymo.top/docs',
  ].join('\n'));
  assert.equal(notes, [
    "What's Changed",
    '- Run verify on every pull request',
    '- Cloudflare R2 sign-in and backups',
    '',
    'New Contributors',
    // The "in" goes with the address, so no line ends on a preposition.
    '- @locmaymo made their first contribution',
    '',
    'Read more at',
  ].join('\n'));
});

test('notes longer than a card can hold are cut, and say so', () => {
  const long = Array.from({ length: 200 }, (_, index) => `- change number ${index.toString(10)}`).join('\n');
  const notes = releaseNotes(long);
  assert.ok(notes.length < long.length);
  assert.ok(notes.endsWith('…'));
  assert.ok(!notes.includes('change number 199'));
});
