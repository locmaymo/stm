import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument, type Document, type YAMLMap } from 'yaml';
import type { ConfigDocument, ConfigSettings, ConfigUpdateInput, Installation, Profile } from '../../contracts/src/index.js';

const CONFIG_SCHEMA_VERSION = 1 as const;
const REDACTED_PASSWORD = '********';
const DEFAULT_BASIC_AUTH_USER = { username: 'user', password: 'password' } as const;

export class ConfigError extends Error {
  public readonly code: 'config_missing' | 'invalid_yaml' | 'invalid_config' | 'invalid_security';

  public constructor(code: ConfigError['code'], message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export interface ConfigStoreOptions {
  readonly logger?: (line: string) => void;
}

/** Reads and updates the active SillyTavern YAML document without replacing unknown keys. */
export class ConfigStore {
  private readonly logger: (line: string) => void;

  public constructor(options: ConfigStoreOptions = {}) {
    this.logger = options.logger ?? ((line) => console.log(line));
  }

  public async read(profile: Profile, installation: Installation): Promise<ConfigDocument> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const raw = await readConfig(path);
    const document = parseYaml(raw);
    return toConfigDocument(document, raw, path, profile, installation);
  }

  /** Returns whether active Basic Auth must be disabled or account mode enabled. */
  public async needsAccountMigration(profile: Profile, installation: Installation): Promise<boolean> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const document = parseYaml(await readConfig(path));
    return getPath(document, ['basicAuthMode']) === true
      || getPath(document, ['enableUserAccounts']) !== true;
  }

  public async validate(rawYaml: string): Promise<ConfigSettings> {
    const document = parseYaml(rawYaml);
    return extractSettings(document);
  }

  public async update(profile: Profile, installation: Installation, input: ConfigUpdateInput): Promise<ConfigDocument> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const previousRaw = await readConfig(path);
    const previousDocument = parseYaml(previousRaw);
    const document = input.rawYaml === undefined ? previousDocument : parseYaml(input.rawYaml);
    if (getPath(document, ['basicAuthUser', 'password']) === REDACTED_PASSWORD) {
      setPath(document, ['basicAuthUser', 'password'], getPath(previousDocument, ['basicAuthUser', 'password']) ?? DEFAULT_BASIC_AUTH_USER.password);
    }
    applySettings(document, input.settings);
    // Disable Basic Auth while retaining its YAML keys. SillyTavern restores
    // missing defaults at startup, so removing them causes repeated rewrites.
    setPath(document, ['enableUserAccounts'], true);
    setPath(document, ['basicAuthMode'], false);
    for (const key of ['username', 'password'] as const) {
      if (getPath(document, ['basicAuthUser', key]) === undefined) {
        setPath(document, ['basicAuthUser', key], DEFAULT_BASIC_AUTH_USER[key]);
      }
    }
    const settings = extractSettings(document);
    if (settings.listen) {
      setPath(document, ['whitelistMode'], false);
    }
    if (settings.port !== 8000) {
      throw new ConfigError('invalid_config', 'SillyTavern must keep port 8000 when managed by SillyTavern Manager');
    }
    const nextRaw = String(document);
    await atomicWriteYaml(path, nextRaw);
    this.logger(`[config] updated ${path}`);
    const savedDocument = parseYaml(nextRaw);
    return toConfigDocument(savedDocument, nextRaw, path, profile, installation);
  }
}

async function resolveConfigPath(profile: Profile, runtimePath: string): Promise<string> {
  if (profile.layout === 'data') {
    try { await stat(profile.configPath); return profile.configPath; } catch { /* initialize from the runtime template below */ }
    for (const candidate of [join(runtimePath, 'config.yaml'), join(runtimePath, 'config.yml')]) {
      try {
        await stat(candidate);
        await mkdir(dirname(profile.configPath), { recursive: true });
        await copyFile(candidate, profile.configPath);
        return profile.configPath;
      } catch { /* try the next layout */ }
    }
    return profile.configPath;
  }
  const candidates = [profile.configPath, join(runtimePath, 'config.yaml'), join(runtimePath, 'config.yml')];
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate; } catch { /* try the next layout */ }
  }
  return profile.configPath;
}

async function readConfig(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error: unknown) { throw new ConfigError('config_missing', `SillyTavern config was not found at ${path}`); }
}

function parseYaml(raw: string): Document.Parsed {
  try {
    const document = parseDocument(raw, { prettyErrors: false });
    if (document.errors.length > 0) throw document.errors[0];
    if (!document.contents || !Array.isArray((document.contents as YAMLMap).items)) throw new Error('root must be a mapping');
    return document;
  } catch (error: unknown) {
    throw new ConfigError('invalid_yaml', error instanceof Error ? `SillyTavern config YAML is invalid: ${error.message}` : 'SillyTavern config YAML is invalid');
  }
}

function toConfigDocument(document: Document.Parsed, raw: string, path: string, profile: Profile, installation: Installation): ConfigDocument {
  const redacted = parseYaml(raw);
  const password = getPath(redacted, ['basicAuthUser', 'password']);
  if (typeof password === 'string' && password && password !== DEFAULT_BASIC_AUTH_USER.password) {
    setPath(redacted, ['basicAuthUser', 'password'], REDACTED_PASSWORD);
  }
  const settings = extractSettings(document);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    installationId: installation.id,
    runtimeRef: installation.resolvedRef,
    ...(installation.revision ? { runtimeRevision: installation.revision } : {}),
    path,
    format: path.toLowerCase().endsWith('.yml') ? 'yml' : 'yaml',
    rawYaml: String(redacted),
    settings,
    restartRequired: true,
  };
}

function extractSettings(document: Document.Parsed): ConfigSettings {
  const getBoolean = (path: string[], fallback: boolean): boolean => {
    const value = getPath(document, path);
    return typeof value === 'boolean' ? value : fallback;
  };
  const getString = (path: string[], fallback: string): string => {
    const value = getPath(document, path);
    return typeof value === 'string' ? value : fallback;
  };
  const portValue = getPath(document, ['port']);
  return {
    listen: getBoolean(['listen'], false),
    listenAddress: {
      ipv4: getString(['listenAddress', 'ipv4'], '0.0.0.0'),
      ipv6: getString(['listenAddress', 'ipv6'], '[::]'),
    },
    whitelistMode: getBoolean(['whitelistMode'], true),
    port: typeof portValue === 'number' ? portValue : 8000,
    enableUserAccounts: getBoolean(['enableUserAccounts'], false),
    sslEnabled: getBoolean(['ssl', 'enabled'], false),
    enableCorsProxy: getBoolean(['enableCorsProxy'], false),
    disableCsrfProtection: getBoolean(['disableCsrfProtection'], false),
  };
}

function applySettings(document: Document.Parsed, settings: ConfigUpdateInput['settings']): void {
  if (!settings) return;
  if (settings.listen !== undefined) setPath(document, ['listen'], settings.listen);
  if (settings.listenAddress?.ipv4 !== undefined) setPath(document, ['listenAddress', 'ipv4'], settings.listenAddress.ipv4);
  if (settings.listenAddress?.ipv6 !== undefined) setPath(document, ['listenAddress', 'ipv6'], settings.listenAddress.ipv6);
  if (settings.enableUserAccounts !== undefined) setPath(document, ['enableUserAccounts'], settings.enableUserAccounts);
  if (settings.sslEnabled !== undefined) setPath(document, ['ssl', 'enabled'], settings.sslEnabled);
  if (settings.enableCorsProxy !== undefined) setPath(document, ['enableCorsProxy'], settings.enableCorsProxy);
  if (settings.disableCsrfProtection !== undefined) setPath(document, ['disableCsrfProtection'], settings.disableCsrfProtection);
}

function getPath(document: Document.Parsed, path: string[]): unknown {
  return document.getIn(path);
}

function setPath(document: Document.Parsed, path: string[], value: unknown): void {
  document.setIn(path, value);
}

async function atomicWriteYaml(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try { await copyFile(path, `${path}.bak`); } catch { /* first write has no previous file */ }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
