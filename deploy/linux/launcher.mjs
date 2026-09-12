import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = process.env.STM_APP_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const child = spawn(process.execPath, ['--import', 'tsx', join(repositoryRoot, 'apps', 'manager-server', 'src', 'main.ts')], {
  cwd: repositoryRoot,
  env: { ...process.env },
  stdio: 'inherit',
});
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
