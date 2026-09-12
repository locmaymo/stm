import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(repositoryRoot, 'build', 'release', 'windows-x64');
const resourcesRoot = join(releaseRoot, 'resources');
const appRoot = join(resourcesRoot, 'app');
const panelRoot = join(resourcesRoot, 'panel');
const runtimeRoot = join(resourcesRoot, 'runtime');
const executable = join(releaseRoot, 'SillyTavernManager.exe');
const blob = join(releaseRoot, 'SillyTavernManager.blob');

if (process.platform !== 'win32') throw new Error('The Windows portable bundle must be built on Windows.');

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });
run('npm', ['run', 'panel:build']);
run(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(repositoryRoot, 'packaging', 'windows', 'tsconfig.release.json')]);

await cp(join(repositoryRoot, 'apps', 'manager-panel', 'dist'), panelRoot, { recursive: true });
for (const file of ['loader.mjs', 'observer.mjs', 'node-fetch-hook.mjs']) {
  await cp(join(repositoryRoot, 'packages', 'instrumentation', 'src', file), join(appRoot, 'packages', 'instrumentation', 'src', file));
}
await cp(join(repositoryRoot, 'packaging', 'windows', 'runtime-package.json'), join(appRoot, 'package.json'));
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock', '--prefix', appRoot]);
await cp(process.execPath, join(runtimeRoot, 'node.exe'));
await cp(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), join(releaseRoot, 'THIRD_PARTY_NOTICES.md'));
const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
await writeFile(join(resourcesRoot, 'release.json'), `${JSON.stringify({ version: packageJson.version, platform: 'windows-x64', dataLocation: '%LOCALAPPDATA%\\SillyTavernManager' }, null, 2)}\n`, 'utf8');

const seaConfig = join(repositoryRoot, 'build', 'release', 'sea-config.json');
await writeFile(seaConfig, `${JSON.stringify({ main: join(repositoryRoot, 'packaging', 'windows', 'launcher.mjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)}\n`, 'utf8');
run(process.execPath, ['--experimental-sea-config', seaConfig]);
await cp(process.execPath, executable);
const sentinelFuse = readFileSync(executable, 'latin1').match(/NODE_SEA_FUSE_[A-Za-z0-9-]+/u)?.[0];
if (!sentinelFuse) throw new Error('Could not find the Node SEA sentinel fuse.');
run('npx', ['--no-install', 'postject', executable, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', sentinelFuse]);
await rm(blob, { force: true });
await rm(seaConfig, { force: true });

function run(command, args) {
  const executableName = process.platform === 'win32' && (command === 'npm' || command === 'npx') ? `${command}.cmd` : command;
  const useShell = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const result = spawnSync(executableName, args, { cwd: repositoryRoot, stdio: 'inherit', shell: useShell });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
}
