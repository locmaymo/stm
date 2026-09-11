import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Profile, ProfileLayout, ProfileSnapshot } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const PROFILE_STATE_FILE = 'profiles.json';
const PROFILE_SCHEMA_VERSION = 1 as const;

export interface ProfileStoreOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  readonly logger?: (line: string) => void;
}

export interface ProfileCreateInput {
  readonly name: string;
  readonly installationId: string;
  readonly runtimePath: string;
  readonly layout?: ProfileLayout;
}

export type { ProfileSnapshot } from '../../contracts/src/index.js';

interface PersistedProfiles {
  readonly schemaVersion: 1;
  readonly profiles: Profile[];
}

/**
 * Owns profile metadata and profile data roots. It deliberately never moves
 * files between `public/` and `data/`; layout migration is a separate batch.
 */
export class ProfileStore {
  readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private readonly logger: (line: string) => void;
  private profiles: Profile[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: ProfileStoreOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(line));
  }

  public async list(): Promise<Profile[]> {
    return (await this.load()).map((profile) => ({ ...profile }));
  }

  public async get(id: string): Promise<Profile | null> {
    return (await this.load()).find((profile) => profile.id === id) ?? null;
  }

  public async getActive(): Promise<Profile | null> {
    return (await this.load()).find((profile) => profile.active) ?? null;
  }

  public async getActiveForInstallation(installationId: string): Promise<Profile | null> {
    return (await this.load()).find((profile) => profile.active && profile.installationId === installationId) ?? null;
  }

  /** Ensure a ready installation always has one usable profile. */
  public async ensureDefault(input: Omit<ProfileCreateInput, 'name' | 'layout'> & { readonly displayName?: string }): Promise<Profile> {
    const profiles = await this.load();
    const forInstallation = profiles.filter((profile) => profile.installationId === input.installationId);
    if (forInstallation.length > 0) {
      const active = forInstallation.find((profile) => profile.active);
      if (active) return { ...active };
      const first = forInstallation[0];
      if (!first) throw new Error('Profile state is empty');
      return this.activate(first.id);
    }
    return this.create({
      name: input.displayName?.trim() || 'Default',
      installationId: input.installationId,
      runtimePath: input.runtimePath,
    }, true);
  }

  public async create(input: ProfileCreateInput, activate = false): Promise<Profile> {
    const name = normalizeName(input.name);
    const profiles = await this.load();
    if (profiles.some((profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new ProfileError('profile_name_taken', 'A profile with this name already exists');
    }
    const layout = input.layout ?? await detectLayout(input.runtimePath);
    const id = randomUUID();
    const profileRoot = join(this.paths.profiles, '.profile-data', id);
    const dataPath = layout === 'data' ? join(profileRoot, 'data') : join(input.runtimePath, 'public');
    const configPath = layout === 'data' ? join(profileRoot, 'config.yaml') : join(input.runtimePath, 'config.yaml');
    if (layout === 'data') await mkdir(dataPath, { recursive: true });
    else await mkdir(dataPath, { recursive: true });
    const now = this.now().toISOString();
    const shouldActivate = activate || profiles.length === 0;
    const profile: Profile = {
      id,
      name,
      installationId: input.installationId,
      runtimePath: resolve(input.runtimePath),
      configPath: resolve(configPath),
      dataPath: resolve(dataPath),
      layout,
      active: shouldActivate,
      createdAt: now,
      updatedAt: now,
      activatedAt: shouldActivate ? now : null,
    };
    const next = shouldActivate ? profiles.map((item) => ({ ...item, active: false })) : profiles;
    next.push(profile);
    await this.save(next);
    this.logger(`[profiles] created ${profile.name} (${profile.layout})`);
    return { ...profile };
  }

  public async activate(id: string): Promise<Profile> {
    const profiles = await this.load();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProfileError('profile_not_found', 'Profile not found');
    const now = this.now().toISOString();
    const next = profiles.map((profile) => ({
      ...profile,
      active: profile.id === id,
      activatedAt: profile.id === id ? now : profile.activatedAt,
      updatedAt: profile.id === id ? now : profile.updatedAt,
    }));
    await this.save(next);
    this.logger(`[profiles] activated ${target.name}`);
    const activated = next.find((profile) => profile.id === id);
    if (!activated) throw new Error('Profile disappeared after activation');
    return { ...activated };
  }

  /**
   * Copy only the selected profile roots before a switch. Symlinks are
   * rejected so a snapshot cannot unexpectedly read outside the workspace.
   */
  public async createSafetySnapshot(profile: Profile): Promise<ProfileSnapshot> {
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    const destination = join(this.paths.profiles, '.snapshots', `profile-${profile.id}-${createdAt.replace(/[:.]/gu, '-')}`);
    await mkdir(destination, { recursive: true });
    for (const [name, source] of [['data', profile.dataPath], ['config.yaml', profile.configPath], ['secrets.json', join(profile.runtimePath, 'secrets.json')]] as const) {
      if (await exists(source)) await copyPath(source, join(destination, name));
    }
    const manifest = { schemaVersion: 1, profileId: profile.id, layout: profile.layout, createdAt };
    await writeFile(join(destination, 'snapshot.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.logger(`[profiles] safety snapshot created for ${profile.name}`);
    return { id, profileId: profile.id, createdAt, path: destination };
  }

  private async load(): Promise<Profile[]> {
    if (this.profiles) return this.profiles;
    await mkdir(this.paths.state, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, PROFILE_STATE_FILE), 'utf8'));
      if (!isRecord(parsed) || parsed.schemaVersion !== PROFILE_SCHEMA_VERSION || !Array.isArray(parsed.profiles)) throw new Error('Invalid profile state');
      this.profiles = parsed.profiles.map((profile) => parseProfile(profile));
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      this.profiles = [];
    }
    return this.profiles;
  }

  private async save(profiles: Profile[]): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, PROFILE_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const payload: PersistedProfiles = { schemaVersion: PROFILE_SCHEMA_VERSION, profiles };
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.profiles = profiles;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

export class ProfileError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function detectLayout(runtimePath: string): Promise<ProfileLayout> {
  if (await exists(join(runtimePath, 'data'))) return 'data';
  if (await exists(join(runtimePath, 'public'))) return 'public';
  return 'data';
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 80) throw new ProfileError('invalid_profile_name', 'Profile name must be between 1 and 80 characters');
  return name;
}

function parseProfile(value: unknown): Profile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.installationId !== 'string' || typeof value.runtimePath !== 'string' || typeof value.configPath !== 'string' || typeof value.dataPath !== 'string' || (value.layout !== 'data' && value.layout !== 'public') || typeof value.active !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || (value.activatedAt !== null && typeof value.activatedAt !== 'string')) {
    throw new Error('Invalid profile state');
  }
  return value as unknown as Profile;
}

async function copyPath(source: string, destination: string): Promise<void> {
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', 'A linked profile path needs review before switching profiles');
  if (details.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of await readdir(source)) await copyPath(join(source, child), join(destination, child));
    return;
  }
  await mkdir(resolve(destination, '..'), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    return isFileNotFound(error) ? false : Promise.reject(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
