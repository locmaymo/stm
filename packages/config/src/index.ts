import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument, type Document, type YAMLMap } from 'yaml';
import { logEvent, logLineText, type AccessMode, type ConfigDocument, type ConfigSettings, type ConfigUpdateInput, type Installation, type LogSink, type Profile } from '../../contracts/src/index.js';

const CONFIG_SCHEMA_VERSION = 1 as const;
const REDACTED_PASSWORD = '********';
const DEFAULT_BASIC_AUTH_USER = { username: 'user', password: 'password' } as const;
/**
 * Files that only exist in a SillyTavern that has user accounts.
 *
 * Accounts arrived in 1.12. Before that there is no account to hold a password,
 * `enableUserAccounts` is an unknown key, and /api/users/list does not exist -
 * which is what left older versions with no way to set a password at all, and
 * so with no LAN address and no tunnel either.
 */
const ACCOUNT_RUNTIME_MARKERS = ['src/users.js', 'src/endpoints/users-admin.js'] as const;

export class ConfigError extends Error {
  public readonly code: 'config_missing' | 'invalid_yaml' | 'invalid_config' | 'invalid_security';

  public constructor(code: ConfigError['code'], message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export interface ConfigStoreOptions {
  readonly logger?: LogSink;
}

/** Reads and updates the active SillyTavern YAML document without replacing unknown keys. */
export class ConfigStore {
  private readonly logger: LogSink;

  public constructor(options: ConfigStoreOptions = {}) {
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
  }

  public async read(profile: Profile, installation: Installation): Promise<ConfigDocument> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const raw = await readConfig(path);
    const document = parseYaml(raw);
    return toConfigDocument(document, raw, path, installation, await this.accessMode(installation));
  }

  /** Whether this installed version has user accounts, or only Basic Auth. */
  public async accessMode(installation: Installation): Promise<AccessMode> {
    for (const marker of ACCOUNT_RUNTIME_MARKERS) {
      try { await stat(join(installation.runtimePath, ...marker.split('/'))); return 'accounts'; } catch { /* try the next marker */ }
    }
    // A shipped default template naming the key is the same evidence, and it
    // survives a layout change that moves the files above.
    try {
      if ((await readFile(join(installation.runtimePath, 'default', 'config.yaml'), 'utf8')).includes('enableUserAccounts')) return 'accounts';
    } catch { /* older versions ship no default template */ }
    return 'basicAuth';
  }

  /** What the panel needs to report Basic Auth, without reading the password out. */
  public async readBasicAuth(profile: Profile, installation: Installation): Promise<{ username: string; passwordConfigured: boolean; enabled: boolean }> {
    const document = parseYaml(await readConfig(await resolveConfigPath(profile, installation.runtimePath)));
    const username = getPath(document, ['basicAuthUser', 'username']);
    const password = getPath(document, ['basicAuthUser', 'password']);
    return {
      username: typeof username === 'string' && username ? username : DEFAULT_BASIC_AUTH_USER.username,
      passwordConfigured: typeof password === 'string' && password.length > 0 && password !== DEFAULT_BASIC_AUTH_USER.password,
      enabled: getPath(document, ['basicAuthMode']) === true,
    };
  }

  /**
   * Give a version without user accounts the only password it understands.
   *
   * Basic Auth is checked by the HTTP layer before anything else, so it guards
   * a LAN address or a tunnel exactly as an account password would.
   */
  public async setBasicAuthPassword(profile: Profile, installation: Installation, password: string): Promise<ConfigDocument> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const document = parseYaml(await readConfig(path));
    if (getPath(document, ['basicAuthUser', 'username']) === undefined) setPath(document, ['basicAuthUser', 'username'], DEFAULT_BASIC_AUTH_USER.username);
    setPath(document, ['basicAuthUser', 'password'], password);
    setPath(document, ['basicAuthMode'], true);
    const nextRaw = String(document);
    await atomicWriteYaml(path, nextRaw);
    this.logger(logEvent('config.basicAuthPasswordSet', '[config] set the Basic Auth password in ' + path, { path }));
    return toConfigDocument(parseYaml(nextRaw), nextRaw, path, installation, 'basicAuth');
  }

  /**
   * Returns whether active Basic Auth must be disabled or account mode enabled.
   *
   * Never for a version without accounts: there is nothing to migrate to, and
   * answering yes rewrote that config on every single start.
   */
  public async needsAccountMigration(profile: Profile, installation: Installation): Promise<boolean> {
    if (await this.accessMode(installation) === 'basicAuth') return false;
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
    const mode = await this.accessMode(installation);
    if (mode === 'accounts') {
      // Disable Basic Auth while retaining its YAML keys. SillyTavern restores
      // missing defaults at startup, so removing them causes repeated rewrites.
      setPath(document, ['enableUserAccounts'], true);
      setPath(document, ['basicAuthMode'], false);
    }
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
    this.logger(logEvent('config.updated', `[config] updated ${path}`, { path }));
    const savedDocument = parseYaml(nextRaw);
    return toConfigDocument(savedDocument, nextRaw, path, installation, mode);
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

function toConfigDocument(document: Document.Parsed, raw: string, path: string, installation: Installation, accessMode: AccessMode): ConfigDocument {
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
    accessMode,
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
    basicAuthMode: getBoolean(['basicAuthMode'], false),
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
