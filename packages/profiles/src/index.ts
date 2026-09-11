import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parse as parseYaml } from 'yaml';
import type { Profile, ProfileLayout, ProfileSnapshot } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const PROFILE_STATE_FILE = 'profiles.json';
const PROFILE_SCHEMA_VERSION = 1 as const;
const DEFAULT_USER_HANDLE = 'default-user';
const MAX_SAFETY_SNAPSHOTS_PER_PROFILE = 3;
const SAFETY_EXCLUDED_NAMES = new Set(['backups', 'thumbnails', 'vectors', '_webpack', '_cache', '_storage', '_uploads', 'node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const LEGACY_RUNTIME_STATIC_NAMES = new Set(['assets', 'css', 'favicon.ico', 'i18n.json', 'img', 'index.html', 'jsconfig.json', 'lib', 'robots.txt', 'script.js', 'scripts', 'sounds', 'st-launcher.ico', 'style.css', 'webfonts']);

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
 * Owns profile metadata and profile data roots. Legacy public/ data is copied
 * into the canonical data/default-user/ root during profile initialization or
 * version switching; the original tree is left untouched.
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
      if (active) {
        if (resolve(active.runtimePath) !== resolve(input.runtimePath)) {
          const rebound = await this.rebind(active.id, input.installationId, input.runtimePath);
          return rebound.layout === 'public' ? this.migrateToData(rebound.id) : rebound;
        }
        return active.layout === 'public' ? this.migrateToData(active.id) : { ...active };
      }
      const first = forInstallation[0];
      if (!first) throw new Error('Profile state is empty');
      const activated = await this.activate(first.id);
      return activated.layout === 'public' ? this.migrateToData(activated.id) : activated;
    }
    const active = profiles.find((profile) => profile.active);
    if (active) return this.rebind(active.id, input.installationId, input.runtimePath);
    const created = await this.create({
      name: input.displayName?.trim() || 'Default',
      installationId: input.installationId,
      runtimePath: input.runtimePath,
      layout: 'data',
    }, true);
    if (await exists(join(input.runtimePath, 'public'))) return this.migrateRuntimePublic(created, input.runtimePath);
    return created;
  }

  public async create(input: ProfileCreateInput, activate = false): Promise<Profile> {
    const name = normalizeName(input.name);
    const profiles = await this.load();
    if (profiles.some((profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new ProfileError('profile_name_taken', 'A profile with this name already exists');
    }
    const layout = input.layout ?? 'data';
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
      legacyLayout: null,
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

  /** Keep profile data while pointing the profile at a newly installed runtime. */
  public async rebind(id: string, installationId: string, runtimePath: string): Promise<Profile> {
    const profiles = await this.load();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProfileError('profile_not_found', 'Profile not found');
    const resolvedRuntimePath = resolve(runtimePath);
    let dataPath = target.dataPath;
    let configPath = target.configPath;
    let layout = target.layout;
    let legacyLayout = target.legacyLayout ?? null;
    if (target.layout === 'public') {
      const migrated = await this.migrateTreeToData(target);
      dataPath = migrated.dataPath;
      configPath = migrated.configPath;
      layout = 'data';
      legacyLayout = 'public';
    }
    const now = this.now().toISOString();
    const next = profiles.map((profile) => profile.id === id ? {
      ...profile,
      installationId,
      runtimePath: resolvedRuntimePath,
      configPath: resolve(configPath),
      dataPath: resolve(dataPath),
      layout,
      legacyLayout,
      active: true,
      updatedAt: now,
      activatedAt: now,
    } : { ...profile, active: false });
    await this.save(next);
    const rebound = next.find((profile) => profile.id === id);
    if (!rebound) throw new Error('Profile disappeared after rebind');
    this.logger(`[profiles] rebound ${rebound.name} to ${installationId} (${rebound.layout})`);
    return { ...rebound };
  }

  /** Convert a legacy public/ profile into the canonical data/default-user root. */
  public async migrateToData(id: string): Promise<Profile> {
    const profiles = await this.load();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProfileError('profile_not_found', 'Profile not found');
    if (target.layout === 'data') return { ...target };
    await this.snapshotLegacyProfile(target);
    const migrated = await this.migrateTreeToData(target);
    const now = this.now().toISOString();
    const next = profiles.map((profile) => profile.id === id ? {
      ...profile,
      layout: 'data' as const,
      dataPath: migrated.dataPath,
      configPath: migrated.configPath,
      legacyLayout: 'public' as const,
      updatedAt: now,
    } : profile);
    await this.save(next);
    const result = next.find((profile) => profile.id === id);
    if (!result) throw new Error('Profile disappeared after migration');
    this.logger(`[profiles] migrated ${result.name} from public/ to data/${DEFAULT_USER_HANDLE}/`);
    return { ...result };
  }

  /** Prepare canonical data for an older runtime that only understands public/. */
  public async prepareForRuntime(profile: Profile, runtimePath: string): Promise<ProfileLayout> {
    if (profile.layout === 'public') return 'public';
    if (await runtimeSupportsDataRoot(runtimePath)) return 'data';
    const source = await resolveUserData(profile.dataPath);
    await syncCanonicalToLegacy(source, runtimePath);
    if (await exists(profile.configPath)) await copyPath(profile.configPath, join(runtimePath, 'config.yaml'));
    await writeLegacyRuntimeConfig(runtimePath);
    this.logger(`[profiles] synchronized ${profile.name} to legacy public/ runtime`);
    return 'public';
  }

  /** Persist changes made by an older runtime back into canonical data/. */
  public async persistFromRuntime(profile: Profile, runtimePath: string, runtimeLayout: ProfileLayout): Promise<void> {
    if (profile.layout !== 'data' || runtimeLayout !== 'public') return;
    const source = join(runtimePath, 'public');
    if (!await exists(source)) return;
    const destination = join(profile.dataPath, DEFAULT_USER_HANDLE);
    await syncLegacyToCanonical(runtimePath, destination);
    const runtimeConfig = join(runtimePath, 'config.yaml');
    if (await exists(runtimeConfig)) await copyPath(runtimeConfig, profile.configPath);
    this.logger(`[profiles] synchronized legacy public/ changes back to ${profile.name}`);
  }

  /**
   * Older SillyTavern releases materialize every character card as a base64
   * string when the character list is requested. Give large legacy profiles a
   * larger V8 heap without changing the canonical files or modern runtimes.
   */
  public async recommendedLegacyHeapMb(profile: Profile): Promise<number | null> {
    if (profile.layout !== 'data') return null;
    const source = await resolveUserData(profile.dataPath);
    const bytes = await treeByteSize(source);
    if (bytes < 512 * 1024 * 1024) return null;
    const gib = bytes / (1024 ** 3);
    const heapGb = Math.min(16, Math.max(8, Math.ceil(gib * 2 + 4)));
    const heapMb = heapGb * 1024;
    this.logger(`[profiles] legacy data is ${gib.toFixed(2)} GiB; using a ${heapMb} MiB Node heap`);
    return heapMb;
  }

  /**
   * Copy only the selected profile roots before a switch. Symlinks are
   * rejected so a snapshot cannot unexpectedly read outside the workspace.
   */
  public async createSafetySnapshot(profile: Profile): Promise<ProfileSnapshot> {
    const fingerprint = await fingerprintProfile(profile);
    const previous = await this.findMatchingSnapshot(profile.id, fingerprint);
    if (previous) {
      this.logger(`[profiles] reused safety snapshot for ${profile.name}`);
      return previous;
    }
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    const destination = join(this.paths.profiles, '.snapshots', `profile-${profile.id}-${createdAt.replace(/[:.]/gu, '-')}`);
    await mkdir(destination, { recursive: true });
    const dataSecrets = profile.layout === 'data' ? join(profile.dataPath, 'default-user', 'secrets.json') : join(profile.runtimePath, 'secrets.json');
    const runtimeSecrets = join(profile.runtimePath, 'secrets.json');
    const secretsPath = await exists(dataSecrets) ? dataSecrets : runtimeSecrets;
    for (const [name, source] of [['data', profile.dataPath], ['config.yaml', profile.configPath], ['secrets.json', secretsPath]] as const) {
      if (await exists(source)) {
        if (name === 'data') await copySafetyTree(source, join(destination, name));
        else await copyPath(source, join(destination, name));
      }
    }
    const manifest = { schemaVersion: 1, profileId: profile.id, layout: profile.layout, createdAt, fingerprint };
    await writeFile(join(destination, 'snapshot.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await this.pruneSafetySnapshots(profile.id);
    this.logger(`[profiles] safety snapshot created for ${profile.name}`);
    return { id, profileId: profile.id, createdAt, path: destination, fingerprint };
  }

  /** Remove old profile snapshots while retaining the newest recovery points. */
  public async pruneSafetySnapshots(profileId?: string): Promise<void> {
    const root = join(this.paths.profiles, '.snapshots');
    if (!await exists(root)) return;
    const names = (await readdir(root)).filter((name) => name.startsWith('profile-') && (!profileId || name.startsWith(`profile-${profileId}-`)));
    const groups = new Map<string, Array<{ name: string; createdAt: string }>>();
    for (const name of names) {
      const manifestPath = join(root, name, 'snapshot.json');
      try {
        const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (isRecord(value) && typeof value.createdAt === 'string') {
          const group = name.split('-').slice(0, 6).join('-');
          const records = groups.get(group) ?? [];
          records.push({ name, createdAt: value.createdAt });
          groups.set(group, records);
        }
      } catch { /* an incomplete snapshot is retained for manual review */ }
    }
    for (const records of groups.values()) {
      records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      for (const record of records.slice(MAX_SAFETY_SNAPSHOTS_PER_PROFILE)) {
        await rm(join(root, record.name), { recursive: true, force: true });
        this.logger(`[profiles] pruned old safety snapshot ${record.name}`);
      }
    }
  }

  private async findMatchingSnapshot(profileId: string, fingerprint: string): Promise<ProfileSnapshot | null> {
    const root = join(this.paths.profiles, '.snapshots');
    if (!await exists(root)) return null;
    const names = (await readdir(root)).filter((name) => name.startsWith(`profile-${profileId}-`));
    for (const name of names) {
      const path = join(root, name);
      try {
        const value: unknown = JSON.parse(await readFile(join(path, 'snapshot.json'), 'utf8'));
        if (!isRecord(value) || value.fingerprint !== fingerprint || typeof value.createdAt !== 'string') continue;
        return { id: name, profileId, createdAt: value.createdAt, path, fingerprint };
      } catch { /* incomplete snapshots are ignored for deduplication */ }
    }
    return null;
  }

  private async migrateRuntimePublic(profile: Profile, runtimePath: string): Promise<Profile> {
    const yamlPath = join(runtimePath, 'config.yaml');
    const legacyConfigPath = await exists(yamlPath) ? yamlPath : join(runtimePath, 'config.yml');
    const legacy: Profile = { ...profile, layout: 'public', dataPath: join(runtimePath, 'public'), configPath: legacyConfigPath };
    await this.snapshotLegacyProfile(legacy);
    const migrated = await this.migrateTreeToData(legacy);
    const now = this.now().toISOString();
    const profiles = await this.load();
    const next = profiles.map((item) => item.id === profile.id ? {
      ...item,
      dataPath: migrated.dataPath,
      configPath: migrated.configPath,
      layout: 'data' as const,
      legacyLayout: 'public' as const,
      updatedAt: now,
    } : item);
    await this.save(next);
    const result = next.find((item) => item.id === profile.id);
    if (!result) throw new Error('Profile disappeared after legacy migration');
    this.logger(`[profiles] migrated ${result.name} from public/ to data/${DEFAULT_USER_HANDLE}/`);
    return { ...result };
  }

  private async migrateTreeToData(profile: Profile): Promise<{ dataPath: string; configPath: string }> {
    const profileRoot = join(this.paths.profiles, '.profile-data', profile.id);
    const dataPath = join(profileRoot, 'data');
    const userPath = join(dataPath, DEFAULT_USER_HANDLE);
    const configPath = join(profileRoot, 'config.yaml');
    await mkdir(userPath, { recursive: true });
    if (await exists(profile.dataPath)) {
      for (const child of await readdir(profile.dataPath)) await copyPath(join(profile.dataPath, child), join(userPath, child));
    }
    if (await exists(profile.configPath) && resolve(profile.configPath) !== resolve(configPath)) await copyPath(profile.configPath, configPath);
    return { dataPath: resolve(dataPath), configPath: resolve(configPath) };
  }

  private async snapshotLegacyProfile(profile: Profile): Promise<void> {
    const destination = join(this.paths.profiles, '.snapshots', `legacy-${profile.id}-${this.now().toISOString().replace(/[:.]/gu, '-')}`);
    if (await exists(profile.dataPath) || await exists(profile.configPath)) {
      await mkdir(destination, { recursive: true });
      if (await exists(profile.dataPath)) await copySafetyTree(profile.dataPath, join(destination, 'public'));
      if (await exists(profile.configPath)) await copyPath(profile.configPath, join(destination, 'config.yaml'));
      await writeFile(join(destination, 'snapshot.json'), `${JSON.stringify({ schemaVersion: 1, profileId: profile.id, layout: 'public', createdAt: this.now().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.logger(`[profiles] legacy safety snapshot created for ${profile.name}`);
    }
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

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 80) throw new ProfileError('invalid_profile_name', 'Profile name must be between 1 and 80 characters');
  return name;
}

function parseProfile(value: unknown): Profile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.installationId !== 'string' || typeof value.runtimePath !== 'string' || typeof value.configPath !== 'string' || typeof value.dataPath !== 'string' || (value.layout !== 'data' && value.layout !== 'public') || (value.legacyLayout !== undefined && value.legacyLayout !== null && value.legacyLayout !== 'data' && value.legacyLayout !== 'public') || typeof value.active !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || (value.activatedAt !== null && typeof value.activatedAt !== 'string')) {
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

async function copySafetyTree(source: string, destination: string): Promise<void> {
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', 'A linked profile path needs review before snapshotting');
  if (details.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of await readdir(source)) {
      if (SAFETY_EXCLUDED_NAMES.has(child)) continue;
      await copySafetyTree(join(source, child), join(destination, child));
    }
    return;
  }
  await mkdir(resolve(destination, '..'), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }));
}

async function fingerprintProfile(profile: Profile): Promise<string> {
  const hash = createHash('sha256');
  await fingerprintTree(profile.dataPath, hash, 'data');
  await fingerprintFile(profile.configPath, hash, 'config');
  const secrets = profile.layout === 'data' ? join(profile.dataPath, DEFAULT_USER_HANDLE, 'secrets.json') : join(profile.runtimePath, 'secrets.json');
  await fingerprintFile(secrets, hash, 'secrets');
  return hash.digest('hex');
}

async function fingerprintTree(root: string, hash: ReturnType<typeof createHash>, prefix: string): Promise<void> {
  let details;
  try { details = await lstat(root); } catch (error: unknown) { if (isFileNotFound(error)) { hash.update(`${prefix}:missing\n`); return; } throw error; }
  if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', 'A linked profile path needs review before snapshotting');
  if (!details.isDirectory()) { hash.update(`${prefix}:file:${details.size}:${details.mtimeMs}\n`); return; }
  const children = (await readdir(root)).filter((child) => !SAFETY_EXCLUDED_NAMES.has(child)).sort((left, right) => left.localeCompare(right));
  for (const child of children) await fingerprintTree(join(root, child), hash, `${prefix}/${child}`);
}

async function fingerprintFile(path: string, hash: ReturnType<typeof createHash>, label: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', 'A linked profile path needs review before snapshotting');
    hash.update(`${label}:${details.size}:${details.mtimeMs}\n`);
  } catch (error: unknown) {
    if (isFileNotFound(error)) hash.update(`${label}:missing\n`);
    else throw error;
  }
}

async function syncCanonicalToLegacy(source: string, runtimePath: string): Promise<void> {
  const publicRoot = join(runtimePath, 'public');
  await mkdir(publicRoot, { recursive: true });
  for (const child of await readdir(publicRoot)) {
    if (!LEGACY_RUNTIME_STATIC_NAMES.has(child)) await rm(join(publicRoot, child), { recursive: true, force: true });
  }
  for (const child of ['backups', 'thumbnails', 'vectors']) await rm(join(runtimePath, child), { recursive: true, force: true });
  await rm(join(publicRoot, 'scripts', 'extensions', 'third-party'), { recursive: true, force: true });
  if (!await exists(source)) return;
  for (const child of await readdir(source)) {
    if (child === 'secrets.json') continue;
    const sourcePath = join(source, child);
    if (child === 'extensions') await copyPath(sourcePath, join(publicRoot, 'scripts', 'extensions', 'third-party'));
    else if (['backups', 'thumbnails', 'vectors'].includes(child)) await copyPath(sourcePath, join(runtimePath, child));
    else await copyPath(sourcePath, join(publicRoot, child));
  }
  const sourceSecrets = join(source, 'secrets.json');
  if (await exists(sourceSecrets)) await copyPath(sourceSecrets, join(runtimePath, 'secrets.json'));
}

async function syncLegacyToCanonical(runtimePath: string, destination: string): Promise<void> {
  const source = join(runtimePath, 'public');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const child of await readdir(source)) {
    if (LEGACY_RUNTIME_STATIC_NAMES.has(child)) continue;
    if (child === 'secrets.json') continue;
    await copyPath(join(source, child), join(destination, child));
  }
  const extensionSource = join(source, 'scripts', 'extensions', 'third-party');
  if (await exists(extensionSource)) await copyPath(extensionSource, join(destination, 'extensions'));
  const runtimeSecrets = join(runtimePath, 'secrets.json');
  if (await exists(runtimeSecrets)) await copyPath(runtimeSecrets, join(destination, 'secrets.json'));
  for (const child of ['backups', 'thumbnails', 'vectors']) {
    const rootPath = join(runtimePath, child);
    if (await exists(rootPath)) await copyPath(rootPath, join(destination, child));
  }
}

async function resolveUserData(dataPath: string): Promise<string> {
  const userPath = join(dataPath, DEFAULT_USER_HANDLE);
  return await exists(userPath) ? userPath : dataPath;
}

async function treeByteSize(root: string): Promise<number> {
  try {
    const details = await lstat(root);
    if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', 'A linked profile path needs review before starting a legacy runtime');
    if (details.isFile()) return details.size;
    if (!details.isDirectory()) return 0;
    let total = 0;
    for (const child of await readdir(root)) total += await treeByteSize(join(root, child));
    return total;
  } catch (error: unknown) {
    if (isFileNotFound(error)) return 0;
    throw error;
  }
}

async function runtimeSupportsDataRoot(runtimePath: string): Promise<boolean> {
  try { return (await readFile(join(runtimePath, 'server.js'), 'utf8')).includes('dataRoot'); } catch { return false; }
}

async function writeLegacyRuntimeConfig(runtimePath: string): Promise<void> {
  const defaults = join(runtimePath, 'default', 'config.conf');
  if (!await exists(defaults)) return;
  let config: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(await readFile(join(runtimePath, 'config.yaml'), 'utf8')) as unknown;
    if (isRecord(parsed)) config = parsed;
  } catch { /* the legacy default remains the fallback */ }
  const overrides = {
    port: 8000,
    // Legacy runtimes do not reliably support account sessions. Keep them
    // local-only instead of falling back to the removed Basic Auth mode.
    listen: false,
    autorun: false,
    enableUserAccounts: config.enableUserAccounts === true,
    enableCorsProxy: config.enableCorsProxy === true,
    disableCsrfProtection: config.disableCsrfProtection === true,
  };
  const payload = `const defaults = require('./default/config.conf');\nmodule.exports = { ...defaults, ${JSON.stringify(overrides).slice(1, -1)} };\n`;
  await writeFile(join(runtimePath, 'config.conf'), payload, { encoding: 'utf8', mode: 0o600 });
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
