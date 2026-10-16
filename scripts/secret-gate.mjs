import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Fails when a tracked file holds a Google OAuth secret or token.
 *
 * The repository is public. The Google client secret lives only as a secret
 * on the token broker (`deploy/oauth-relay`), and the manager keeps users'
 * tokens in its state directory, never in the tree. A secret that reached a
 * commit would be revoked once found, and every user's Drive backup would
 * stop with it. GitHub's push protection catches these too, but only on the
 * server and only when it is turned on; this runs in `npm run verify`, before
 * anything is pushed.
 */

const PATTERNS = [
  { name: 'Google OAuth client secret', pattern: /GOCSPX-[A-Za-z0-9_-]{28}/u },
  { name: 'Google access token', pattern: /ya29\.[A-Za-z0-9_-]{20,}/u },
  { name: 'Google refresh token', pattern: /1\/\/0[A-Za-z0-9_-]{30,}/u },
];

/** The downloaded client file, under the name Google gives it. */
const CLIENT_FILE = /(?:^|\/)client_secret_[^/]*\.json$/u;

/** What in `text` looks like a secret, by kind. */
export function findSecrets(text) {
  return PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

export function isClientSecretFile(path) {
  return CLIENT_FILE.test(path.replaceAll('\\', '/'));
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const failures = [];
  for (const file of files) {
    if (isClientSecretFile(file)) failures.push(`${file}: a downloaded OAuth client file`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // listed but deleted in the working tree
    }
    for (const name of findSecrets(text)) failures.push(`${file}: looks like a ${name}`);
  }
  if (failures.length > 0) {
    console.error('Secret gate failed. Remove these before committing:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`Secret gate passed (${files.length} tracked files).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
