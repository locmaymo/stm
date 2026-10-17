import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(repositoryRoot, 'build', 'release', 'windows-x64');
const dotnetOutRoot = join(repositoryRoot, 'build', 'release', 'dotnet');
const cacheRoot = join(repositoryRoot, 'build', 'cache');
const resourcesRoot = join(releaseRoot, 'resources');
const appRoot = join(resourcesRoot, 'app');
const panelRoot = join(resourcesRoot, 'panel');
const runtimeRoot = join(resourcesRoot, 'runtime');
const gitRoot = join(resourcesRoot, 'git');
const binRoot = join(resourcesRoot, 'bin');

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

/*
 * cloudflared, so the first link somebody turns on does not start with a 55 MB
 * download. Pinned and checked the same way. It is a starting point rather
 * than the only one the manager will use: when it is close to a year old, or
 * stops before it connects, the manager fetches the current build into its
 * own data folder and prefers that (see `packages/tunnel`).
 */
const CLOUDFLARED = {
  version: '2026.9.3',
  url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-windows-amd64.exe',
  sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2',
};

/*
 * Microsoft's signed WebView2 WinForms and loader assemblies, and the portable
 * NSIS compiler that builds the per-user `-setup.exe` installer. Both are
 * pinned and verified by SHA-256 before anything runs them.
 */
const WEBVIEW2 = {
  version: '1.0.2903.40',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg',
  sha256: 'ef128016dd1e51c59178c827ed5b8aa3322c57afa8675d930f8109505542ad74',
};

const NSIS = {
  version: '3.11',
  url: 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip',
  sha256: 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
};

if (process.platform !== 'win32') throw new Error('The Windows release must be built on Windows.');

await rm(releaseRoot, { recursive: true, force: true });
await rm(dotnetOutRoot, { recursive: true, force: true });
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
// npm sees the repository's root `package.json` above `build/` and links its
// workspaces into `node_modules/@stm/*` as Windows junctions. The compiled
// server imports those packages by relative path, so the junctions are unused,
// and leaving them in the release tree lets archivers follow them back into the
// repository root.
await dropLinks(join(appRoot, 'node_modules'));

await mkdir(runtimeRoot, { recursive: true });
await cp(process.execPath, join(runtimeRoot, 'node.exe'));
await bundleNpm();
await bundleGit();
await bundleCloudflared();
await cp(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), join(releaseRoot, 'THIRD_PARTY_NOTICES.md'));
await cp(join(repositoryRoot, 'LICENSE'), join(releaseRoot, 'LICENSE'));
// Sorts first in Explorer, so it is the file someone sees before the exe.
await cp(join(repositoryRoot, 'packaging', 'windows', 'FIRST-RUN.txt'), join(releaseRoot, 'Read me first.txt'));
await writeFile(join(resourcesRoot, 'release.json'), `${JSON.stringify({ version: rootPackage.version, platform: 'windows-x64', dataLocation: '%LOCALAPPDATA%\\SillyTavernManager' }, null, 2)}\n`, 'utf8');

await buildDesktopApp(rootPackage.version);
await buildNsisInstaller(rootPackage.version);

/**
 * Compile the native C#/.NET Framework 4.8 + WebView2 desktop launcher and copy
 * its executable and WebView2 assemblies into the release root.
 */
async function buildDesktopApp(version) {
  const nupkg = await ensureCachedFile(
    `microsoft.web.webview2.${WEBVIEW2.version}.nupkg`,
    WEBVIEW2.url,
    WEBVIEW2.sha256,
    'WebView2 NuGet',
  );
  const webviewPkgDir = join(cacheRoot, `webview2-${WEBVIEW2.version}`);
  if (!existsSync(join(webviewPkgDir, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll'))) {
    await rm(webviewPkgDir, { recursive: true, force: true });
    await mkdir(webviewPkgDir, { recursive: true });
    run(systemTar(), ['-xf', nupkg, '-C', webviewPkgDir]);
  }

  const csproj = join(repositoryRoot, 'packaging', 'windows', 'app', 'SillyTavernManager.csproj');
  run('dotnet', [
    'build',
    csproj,
    '-c', 'Release',
    '-v', 'minimal',
    `-p:Version=${version}`,
    `-p:FileVersion=${version}.0`,
    `-p:InformationalVersion=${version}`,
    `-p:WebView2PkgRoot=${webviewPkgDir}`,
  ]);

  const builtBinDir = join(dotnetOutRoot, 'bin');
  for (const file of [
    'SillyTavernManager.exe',
    'SillyTavernManager.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]) {
    const src = join(builtBinDir, file);
    if (existsSync(src)) {
      await cp(src, join(releaseRoot, file));
    } else if (file !== 'SillyTavernManager.exe.config') {
      throw new Error(`Expected desktop build output missing: ${src}`);
    }
  }
}

/**
 * Package the release directory into a per-user NSIS setup executable and write
 * its companion `.sha256` checksum file.
 */
async function buildNsisInstaller(version) {
  const archive = await ensureCachedFile(
    `nsis-${NSIS.version}.zip`,
    NSIS.url,
    NSIS.sha256,
    'NSIS',
  );
  const nsisExtractRoot = join(cacheRoot, `nsis-${NSIS.version}-bin`);
  const makensis = join(nsisExtractRoot, `nsis-${NSIS.version}`, 'makensis.exe');
  if (!existsSync(makensis)) {
    await rm(nsisExtractRoot, { recursive: true, force: true });
    await mkdir(nsisExtractRoot, { recursive: true });
    run(systemTar(), ['-xf', archive, '-C', nsisExtractRoot]);
    if (!existsSync(makensis)) throw new Error('NSIS archive unpacked without makensis.exe');
  }

  const installerName = `SillyTavernManager-windows-x64-v${version}-setup.exe`;
  const installerPath = join(repositoryRoot, 'build', installerName);
  await rm(installerPath, { force: true });

  const nsiScript = join(repositoryRoot, 'packaging', 'windows', 'installer.nsi');
  const icoFile = join(repositoryRoot, 'packaging', 'windows', 'app.ico');
  run(makensis, [
    '/V2',
    `/DVERSION=${version}`,
    `/DSOURCE_DIR=${releaseRoot}`,
    `/DOUT_FILE=${installerPath}`,
    `/DICO_FILE=${icoFile}`,
    nsiScript,
  ]);

  const digest = sha256(await readFile(installerPath));
  await writeFile(`${installerPath}.sha256`, `${digest}  ${installerName}\n`, 'utf8');
}

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
  const archive = await ensureCachedFile(
    `MinGit-${MINGIT.version}-64-bit.zip`,
    MINGIT.url,
    MINGIT.sha256,
    'MinGit',
  );
  await mkdir(gitRoot, { recursive: true });
  // Windows' own bsdtar reads ZIP archives, so nothing else is needed to unpack one.
  run(systemTar(), ['-xf', archive, '-C', gitRoot]);
  if (!existsSync(join(gitRoot, 'cmd', 'git.exe'))) throw new Error('MinGit unpacked without cmd\\git.exe');
}

async function bundleCloudflared() {
  const cached = await ensureCachedFile(
    `cloudflared-${CLOUDFLARED.version}-windows-amd64.exe`,
    CLOUDFLARED.url,
    CLOUDFLARED.sha256,
    'cloudflared',
  );
  await mkdir(binRoot, { recursive: true });
  await cp(cached, join(binRoot, 'cloudflared.exe'));
}

async function ensureCachedFile(fileName, url, expectedSha256, label) {
  const cached = join(cacheRoot, fileName);
  if (!existsSync(cached) || sha256(await readFile(cached)) !== expectedSha256) {
    await mkdir(cacheRoot, { recursive: true });
    const response = await fetch(url, { headers: { 'user-agent': 'curl/8.7.1' } });
    if (!response.ok) throw new Error(`${label} download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== expectedSha256) throw new Error(`${label} checksum mismatch: expected ${expectedSha256}, got ${actual}`);
    await writeFile(cached, bytes);
  }
  return cached;
}

async function dropLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) await rm(full, { recursive: true, force: true });
    else if (stat.isDirectory()) await dropLinks(full);
  }
}

function systemTar() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
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
