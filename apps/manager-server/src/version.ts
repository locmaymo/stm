import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which version of the manager this is.
 *
 * It had been a literal `'0.1.0'` default that nothing ever overrode, so every
 * installation in the world reported 0.1.0: in the banner it printed at
 * startup, in `/api/v1/health`, and - the one that mattered - as the
 * `appVersion` on every usage summary the project received. The number was not
 * wrong by a little; it was the same number for everybody.
 *
 * Resolved by walking up from this file for the nearest `package.json` that
 * carries a version, which lands correctly on all three packagings: the
 * repository root in a checkout, the published package root on npm, and the
 * application root in the Windows bundle, whose build writes the version into
 * the manifest it ships for exactly this reason.
 *
 * `STM_VERSION` wins, for anyone repackaging this into a layout the walk does
 * not suit. The walk is bounded so a manager unpacked into somebody's project
 * folder cannot climb out of its own directory and report that project's
 * version instead.
 */

const MAX_LEVELS = 6;
const UNKNOWN = '0.0.0';

export function resolveManagerVersion(env: NodeJS.ProcessEnv = process.env, from = fileURLToPath(import.meta.url)): string {
  const configured = env.STM_VERSION?.trim();
  if (configured) return configured;

  let directory = dirname(from);
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const version = versionIn(join(directory, 'package.json'));
    if (version) return version;
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  return UNKNOWN;
}

/** The `version` of a manifest, or null when it has none or cannot be read. */
function versionIn(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** Resolved once, at import, because it cannot change while the process runs. */
export const MANAGER_VERSION = resolveManagerVersion();
