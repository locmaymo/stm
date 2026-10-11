/**
 * One temporary directory for a whole test run, removed when the run ends.
 *
 * Tests make their scratch directories with `mkdtemp(join(tmpdir(), ...))`
 * and mostly leave them there; a run used to leave tens of megabytes behind,
 * and the system's temporary directory grew by that much every time. Loaded
 * before the runner, this points `tmpdir()` at a fresh directory of its own -
 * through the variables Node reads it from, so the files' child processes and
 * every program they start inherit it - and deletes that directory on exit.
 *
 * The runner loads this into each test file's own process, so every file has
 * its own directory and removes it as it exits; a process it starts that
 * loads this too keeps the one it inherited. A file killed mid-test - a
 * timeout, an interrupted run - leaves its directory behind, and a later run
 * removes it once it is a day old.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const PREFIX = 'stm-test-';
const STALE_MS = 24 * 60 * 60 * 1000;

if (!process.env.STM_TEST_TMPDIR) {
  const base = tmpdir();
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(base, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run's, still in use, or gone already.
    }
  }

  const directory = mkdtempSync(join(base, PREFIX));
  process.env.STM_TEST_TMPDIR = directory;
  process.env.TMPDIR = directory;
  process.env.TEMP = directory;
  process.env.TMP = directory;
  process.on('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A program a test started may still hold a file open; the next run sweeps it.
    }
  });
}
