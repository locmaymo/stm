import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repositoryRoot, 'build', 'npm');
const packageRoot = join(buildRoot, 'package');

await rm(buildRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
run(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(repositoryRoot, 'packaging', 'npm', 'tsconfig.release.json')]);
run('npm', ['run', 'panel:build']);
await cp(join(repositoryRoot, 'apps', 'manager-panel', 'dist'), join(packageRoot, 'panel'), { recursive: true });
for (const file of ['loader.mjs', 'observer.mjs', 'node-fetch-hook.mjs']) {
  await cp(join(repositoryRoot, 'packages', 'instrumentation', 'src', file), join(packageRoot, 'packages', 'instrumentation', 'src', file));
}
await cp(join(repositoryRoot, 'packaging', 'npm', 'cli.mjs'), join(packageRoot, 'cli.mjs'));
// The npm page for the package is whatever README lands beside the manifest,
// and the English one links to the Vietnamese one, so both travel together.
for (const file of ['LICENSE', 'README.md', 'README.vi.md']) {
  await cp(join(repositoryRoot, file), join(packageRoot, file));
}
const rootPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const packageManifest = JSON.parse(await readFile(join(repositoryRoot, 'packaging', 'npm', 'package.json'), 'utf8'));
packageManifest.version = rootPackage.version;
await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8');
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock'], packageRoot);
run('npm', ['pack', '--pack-destination', buildRoot], packageRoot);

function run(command, args, cwd = repositoryRoot) {
  const executableName = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const result = spawnSync(executableName, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
}
