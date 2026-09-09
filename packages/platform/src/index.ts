import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PlatformKind } from '../../contracts/src/index.js';

export interface PlatformPaths {
  readonly platform: PlatformKind;
  readonly root: string;
  readonly state: string;
  readonly profiles: string;
  readonly archives: string;
  readonly logs: string;
  readonly metrics: string;
  readonly outbox: string;
  readonly tmp: string;
  readonly bin: string;
}

export interface PlatformPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

function hasTruthyEnvironmentValue(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function detectPlatform(options: PlatformPathOptions = {}): PlatformKind {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (hasTruthyEnvironmentValue(env.STM_MODELSCOPE) || env.MODELSCOPE_HOST || env.MODELSCOPE_ENVIRONMENT) {
    return 'modelscope';
  }
  if (hasTruthyEnvironmentValue(env.STM_DOCKER) || env.DOCKER_CONTAINER === 'true' || env.CONTAINER === 'docker') {
    return 'docker';
  }
  if (env.PREFIX && env.PREFIX.includes('com.termux')) {
    return 'termux';
  }
  if (platform === 'win32') {
    return 'windows';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  return 'unknown';
}

function defaultRoot(kind: PlatformKind, options: PlatformPathOptions, env: NodeJS.ProcessEnv): string {
  const home = options.homeDirectory ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (env.STM_DATA_DIR) {
    return resolve(env.STM_DATA_DIR);
  }
  if (kind === 'modelscope') {
    return '/mnt/workspace/sillytavern-manager';
  }
  if (kind === 'docker') {
    return '/data/sillytavern-manager';
  }
  if (kind === 'termux') {
    return join(env.PREFIX ?? home, 'var', 'sillytavern-manager');
  }
  if (kind === 'windows') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'SillyTavernManager');
  }
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'sillytavern-manager');
}

export function getPlatformPaths(options: PlatformPathOptions = {}): PlatformPaths {
  const env = options.env ?? process.env;
  const platform = detectPlatform(options);
  const root = defaultRoot(platform, options, env);
  return {
    platform,
    root,
    state: join(root, 'state'),
    profiles: join(root, 'profiles'),
    archives: join(root, 'archives'),
    logs: join(root, 'logs'),
    metrics: join(root, 'metrics'),
    outbox: join(root, 'outbox'),
    tmp: join(root, 'tmp'),
    bin: join(root, 'bin'),
  };
}
