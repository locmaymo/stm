import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rcedit } from 'rcedit';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(repositoryRoot, 'build', 'release', 'windows-x64');
const cacheRoot = join(repositoryRoot, 'build', 'cache');
const resourcesRoot = join(releaseRoot, 'resources');
const appRoot = join(resourcesRoot, 'app');
const panelRoot = join(resourcesRoot, 'panel');
const runtimeRoot = join(resourcesRoot, 'runtime');
const gitRoot = join(resourcesRoot, 'git');
const executable = join(releaseRoot, 'SillyTavernManager.exe');
const blob = join(releaseRoot, 'SillyTavernManager.blob');

/*
 * Installing SillyTavern is a Git fetch and then an `npm install`, and a
 * Windows machine fresh out of the box has neither. The bundle carried only
 * `node.exe`, so on exactly the machine it was made for the first install
 * stopped at "Git could not fetch this version" - it had only ever been tried
 * on machines that already had both.
 *
 * MinGit is Git for Windows' own minimal build for applications that ship Git
 * inside them. It is pinned, and checked against the digest its release
 * published, so a release build never picks up bytes nobody looked at.
 */
const MINGIT = {
  version: '2.55.0.5',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip',
  sha256: '56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e',
};

if (process.platform !== 'win32') throw new Error('The Windows portable bundle must be built on Windows.');

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });
run('npm', ['run', 'panel:build']);
run(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(repositoryRoot, 'packaging', 'windows', 'tsconfig.release.json')]);

await mkdir(appRoot, { recursive: true });
await cp(join(repositoryRoot, 'apps', 'manager-panel', 'dist'), panelRoot, { recursive: true });
for (const file of ['loader.mjs', 'observer.mjs', 'node-fetch-hook.mjs']) {
  await cp(join(repositoryRoot, 'packages', 'instrumentation', 'src', file), join(appRoot, 'packages', 'instrumentation', 'src', file));
}
// The manifest carries the version as well as the dependencies: the manager
// finds its own version by walking up for the nearest manifest that has one,
// and in this bundle that is this file.
const rootPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const runtimeManifest = JSON.parse(await readFile(join(repositoryRoot, 'packaging', 'windows', 'runtime-package.json'), 'utf8'));
await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({ ...runtimeManifest, version: rootPackage.version }, null, 2)}\n`, 'utf8');
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock', '--prefix', appRoot]);
await cp(process.execPath, join(runtimeRoot, 'node.exe'));
await bundleNpm();
await bundleGit();
await cp(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), join(releaseRoot, 'THIRD_PARTY_NOTICES.md'));
await cp(join(repositoryRoot, 'LICENSE'), join(releaseRoot, 'LICENSE'));
// Sorts first in Explorer, so it is the file someone sees before the exe.
await cp(join(repositoryRoot, 'packaging', 'windows', 'FIRST-RUN.txt'), join(releaseRoot, 'Read me first.txt'));
await writeFile(join(resourcesRoot, 'release.json'), `${JSON.stringify({ version: rootPackage.version, platform: 'windows-x64', dataLocation: '%LOCALAPPDATA%\\SillyTavernManager' }, null, 2)}\n`, 'utf8');

const seaConfig = join(repositoryRoot, 'build', 'release', 'sea-config.json');
await writeFile(seaConfig, `${JSON.stringify({ main: join(repositoryRoot, 'packaging', 'windows', 'launcher.cjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)}\n`, 'utf8');
run(process.execPath, ['--experimental-sea-config', seaConfig]);
await cp(process.execPath, executable);
// The executable starts life as a copy of node.exe, so without this Explorer
// showed Node's icon and Properties called it "Node.js". Resources are
// rewritten before the application is injected, not after, so rcedit never
// has to carry the injected blob through its own rewrite.
await rcedit(executable, {
  icon: join(repositoryRoot, 'packaging', 'windows', 'app.ico'),
  'file-version': rootPackage.version,
  'product-version': rootPackage.version,
  'version-string': {
    ProductName: 'SillyTavern Manager',
    FileDescription: 'SillyTavern Manager',
    CompanyName: 'SillyTavern Manager',
    LegalCopyright: 'AGPL-3.0-only',
    OriginalFilename: 'SillyTavernManager.exe',
    InternalName: 'SillyTavernManager',
  },
});
const sentinelFuse = readFileSync(executable, 'latin1').match(/NODE_SEA_FUSE_[A-Za-z0-9-]+/u)?.[0];
if (!sentinelFuse) throw new Error('Could not find the Node SEA sentinel fuse.');
run('npx', ['--no-install', 'postject', executable, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', sentinelFuse]);
await rm(blob, { force: true });
await rm(seaConfig, { force: true });

/**
 * The npm that came with the Node building this bundle, laid out the way a
 * Node install lays it out: `npm.cmd` beside `node.exe`, npm itself under
 * `node_modules`. The shim runs the `node.exe` next to it, so the npm and the
 * Node it runs on are always the pair that shipped together.
 */
async function bundleNpm() {
  const nodeInstall = dirname(process.execPath);
  const npmPackage = join(nodeInstall, 'node_modules', 'npm');
  if (!existsSync(join(npmPackage, 'bin', 'npm-cli.js'))) throw new Error(`No npm beside ${process.execPath}; build with a Node install that includes it.`);
  await cp(npmPackage, join(runtimeRoot, 'node_modules', 'npm'), { recursive: true });
  for (const shim of ['npm.cmd', 'npx.cmd']) await cp(join(nodeInstall, shim), join(runtimeRoot, shim));
}

async function bundleGit() {
  const archive = join(cacheRoot, `MinGit-${MINGIT.version}-64-bit.zip`);
  if (!existsSync(archive) || sha256(await readFile(archive)) !== MINGIT.sha256) {
    await mkdir(cacheRoot, { recursive: true });
    const response = await fetch(MINGIT.url);
    if (!response.ok) throw new Error(`MinGit download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== MINGIT.sha256) throw new Error(`MinGit checksum mismatch: expected ${MINGIT.sha256}, got ${actual}`);
    await writeFile(archive, bytes);
  }
  await mkdir(gitRoot, { recursive: true });
  // Windows' own bsdtar reads ZIP archives, so nothing else is needed to unpack one.
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', gitRoot]);
  if (!existsSync(join(gitRoot, 'cmd', 'git.exe'))) throw new Error('MinGit unpacked without cmd\\git.exe');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args) {
  const executableName = process.platform === 'win32' && (command === 'npm' || command === 'npx') ? `${command}.cmd` : command;
  const useShell = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const result = spawnSync(executableName, args, { cwd: repositoryRoot, stdio: 'inherit', shell: useShell });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
}
