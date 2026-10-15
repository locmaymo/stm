import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runPooled } from './index.js';

/**
 * Delete the tree at `root` a couple of files at a time.
 *
 * On network storage each deletion is a round trip, and a recursive `rm` puts
 * thousands of them in flight at once. Node runs file operations on a small
 * pool of threads shared by the whole process, so while those wait, every
 * other file operation here waits behind them: a tree of twenty thousand files
 * being cleared away kept SillyTavern from starting for minutes. Two at a time
 * leaves the pool to everything else, and nothing is waiting for this anyway.
 */
export async function removeTreeGently(root: string, concurrency = 2): Promise<void> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  };
  await walk(root);
  await runPooled(files, concurrency, async (file) => { await rm(file, { force: true }); });
  // Only directories are left, and there are far fewer of them.
  await rm(root, { recursive: true, force: true });
}
