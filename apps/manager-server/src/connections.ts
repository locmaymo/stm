import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectionApiProvider, providerOfSecret, type ConnectionKey, type ConnectionProfile, type ConnectionProxy, type ConnectionsOverview } from '../../../packages/contracts/src/index.js';

/**
 * The keys, proxies and connection profiles SillyTavern keeps, read off the
 * disk.
 *
 * Three things in two files of the profile's user directory:
 *
 * - `secrets.json`, which SillyTavern's server owns: since 1.13.1 every key
 *   name (`api_key_openrouter`, ...) holds a list of `{ id, value, label,
 *   active }`; before that it held one bare string, which SillyTavern turns
 *   into the list form on its next start.
 * - `settings.json`, which the open tab owns: `proxies` and `selected_proxy`
 *   for the reverse proxy presets, and the connection manager's
 *   `extension_settings.connectionManager.{ profiles, selectedProfile }`.
 *
 * Reading needs nothing running. What it returns is what the Connections
 * page shows, so a key leaves only masked and a proxy's password not at all.
 * An address is shown without its query and credentials: some proxies are
 * reached with a token in the address. The one write here,
 * `selectProxyOnDisk`, is for when SillyTavern is stopped.
 */

export const SECRETS_FILE = 'secrets.json';
export const SETTINGS_FILE = 'settings.json';

/** The mark SillyTavern leaves once it has moved bare keys into lists. */
const MIGRATED_MARK = '_migrated';
/** What SillyTavern calls the proxy preset that is no proxy. */
const NO_PROXY = 'None';

/** One key as `secrets.json` holds it, value included; never sent anywhere from here. */
export interface StoredSecret {
  readonly secretKey: string;
  readonly id: string | null;
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
}

/** A proxy preset as `settings.json` holds it, password included. */
export interface StoredProxy {
  readonly name: string;
  readonly url: string;
  readonly password: string;
}

/** A connection profile as the connection manager keeps it. */
export type StoredProfile = Readonly<Record<string, unknown>> & { readonly id: string };

export interface StoredSecrets {
  readonly secrets: readonly StoredSecret[];
  readonly legacy: boolean;
}

export interface StoredSettings {
  readonly proxies: readonly StoredProxy[];
  readonly selectedProxy: string | null;
  readonly profiles: readonly StoredProfile[];
  readonly selectedProfile: string | null;
  /** `oai_settings`, for what the tab uses with no profile: the custom URL, the source. */
  readonly oai: Readonly<Record<string, unknown>>;
}

/** What a file said: its contents, nothing because it is not there, or that it could not be read. */
type Read<T> = { readonly value: T } | { readonly missing: true } | { readonly unreadable: true };

/** The secrets and settings of a user directory, values included, for this machine only. */
export async function readStoredConnections(userRoot: string): Promise<{ secrets: Read<StoredSecrets>; settings: Read<StoredSettings> }> {
  const [secrets, settings] = await Promise.all([
    readJsonFile(join(userRoot, SECRETS_FILE)),
    readJsonFile(join(userRoot, SETTINGS_FILE)),
  ]);
  return {
    secrets: 'value' in secrets ? { value: parseSecrets(secrets.value) } : secrets,
    settings: 'value' in settings ? { value: parseSettings(settings.value) } : settings,
  };
}

/**
 * The Connections page's overview of a user directory, or of nothing.
 *
 * A file that is not there is an empty section; one that is there and is not
 * JSON is named in `unreadable`, so the page can say so rather than claim
 * there are no keys.
 */
export async function readConnections(userRoot: string | null): Promise<Omit<ConnectionsOverview, 'tests' | 'sillyTavernRunning'>> {
  if (!userRoot) return { profile: false, keys: [], proxies: [], profiles: [], legacySecrets: false, unreadable: [] };
  const { secrets, settings } = await readStoredConnections(userRoot);
  const unreadable: Array<'secrets' | 'settings'> = [];
  if ('unreadable' in secrets) unreadable.push('secrets');
  if ('unreadable' in settings) unreadable.push('settings');
  const stored = 'value' in secrets ? secrets.value : { secrets: [], legacy: false };
  const config = 'value' in settings ? settings.value : { proxies: [], selectedProxy: null, profiles: [], selectedProfile: null, oai: {} };
  return { profile: true, ...describeConnections(stored, config), legacySecrets: stored.legacy, unreadable };
}

/** The three lists, with what refers to what worked out. */
export function describeConnections(stored: StoredSecrets, config: StoredSettings): Pick<ConnectionsOverview, 'keys' | 'proxies' | 'profiles'> {
  const byId = new Map(stored.secrets.filter((secret) => secret.id !== null).map((secret) => [secret.id, secret]));
  const profiles: ConnectionProfile[] = config.profiles.map((profile) => {
    const secretId = text(profile['secret-id']);
    const api = text(profile.api);
    const proxy = text(profile.proxy);
    const named = secretId ? byId.get(secretId) ?? null : null;
    return {
      id: profile.id,
      name: text(profile.name) ?? profile.id,
      mode: profile.mode === 'tc' ? 'tc' : 'cc',
      api,
      model: text(profile.model),
      apiUrl: shownAddress(text(profile['api-url'])),
      proxy: proxy && proxy !== NO_PROXY ? proxy : null,
      preset: text(profile.preset),
      secretId,
      secretLabel: named?.label ?? null,
      secretKey: named?.secretKey ?? (api ? secretKeyForApi(api) : null),
      selected: config.selectedProfile === profile.id,
    };
  });
  const keys: ConnectionKey[] = stored.secrets.map((secret) => ({
    secretKey: secret.secretKey,
    provider: providerOfSecret(secret.secretKey),
    id: secret.id,
    label: secret.label,
    masked: maskSecret(secret.value),
    active: secret.active,
    profiles: secret.id ? profiles.filter((profile) => profile.secretId === secret.id).map((profile) => profile.id) : [],
  }));
  const proxies: ConnectionProxy[] = config.proxies.filter((proxy) => proxy.name !== NO_PROXY).map((proxy) => ({
    name: proxy.name,
    url: shownAddress(proxy.url),
    hasPassword: proxy.password !== '',
    selected: config.selectedProxy === proxy.name,
    profiles: profiles.filter((profile) => profile.proxy === proxy.name).map((profile) => profile.id),
  }));
  return { keys, proxies, profiles };
}

/**
 * The keys in `secrets.json`, in either of its forms.
 *
 * Only credentials are listed: addresses SillyTavern files beside them
 * (`libre_url`, `deeplx_url`, ...) are settings, not keys. An entry that is
 * not what SillyTavern writes is passed over rather than guessed at.
 */
export function parseSecrets(value: unknown): StoredSecrets {
  if (!isRecord(value)) return { secrets: [], legacy: false };
  const entries = Object.entries(value).filter(([name]) => name !== MIGRATED_MARK && !/_url$/iu.test(name));
  // SillyTavern's own test for the old form: no list anywhere, and no mark.
  const legacy = !Object.hasOwn(value, MIGRATED_MARK) && entries.length > 0 && !Object.values(value).some(Array.isArray);
  const secrets: StoredSecret[] = [];
  for (const [secretKey, item] of entries) {
    if (legacy) {
      if (typeof item === 'string' && item.trim() !== '') secrets.push({ secretKey, id: null, value: item, label: secretKey, active: true });
      continue;
    }
    if (!Array.isArray(item)) continue;
    for (const entry of item) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.value !== 'string') continue;
      secrets.push({
        secretKey,
        id: entry.id,
        value: entry.value,
        label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : secretKey,
        active: entry.active === true,
      });
    }
  }
  return { secrets, legacy };
}

/** The proxy presets and connection profiles in `settings.json`. */
export function parseSettings(value: unknown): StoredSettings {
  const settings = isRecord(value) ? value : {};
  const proxies: StoredProxy[] = [];
  for (const item of Array.isArray(settings.proxies) ? settings.proxies : []) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') continue;
    if (proxies.some((proxy) => proxy.name === item.name)) continue;
    proxies.push({ name: item.name, url: typeof item.url === 'string' ? item.url : '', password: typeof item.password === 'string' ? item.password : '' });
  }
  const selected = isRecord(settings.selected_proxy) && typeof settings.selected_proxy.name === 'string' ? settings.selected_proxy.name : null;
  const extensionSettings = isRecord(settings.extension_settings) ? settings.extension_settings : {};
  const manager = isRecord(extensionSettings.connectionManager) ? extensionSettings.connectionManager : {};
  const profiles: StoredProfile[] = [];
  for (const item of Array.isArray(manager.profiles) ? manager.profiles : []) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue;
    profiles.push(item as StoredProfile);
  }
  return {
    proxies,
    selectedProxy: selected && selected !== NO_PROXY ? selected : null,
    profiles,
    selectedProfile: typeof manager.selectedProfile === 'string' && manager.selectedProfile !== '' ? manager.selectedProfile : null,
    oai: isRecord(settings.oai_settings) ? settings.oai_settings : {},
  };
}

export class SettingsEditError extends Error {
  public constructor(public readonly code: 'settings_missing' | 'settings_not_round_trip' | 'proxy_missing', message: string) {
    super(message);
  }
}

/**
 * Choose a reverse proxy preset in `settings.json`, with SillyTavern stopped.
 *
 * `settings.json` belongs to the open tab, which saves it whole, so this is
 * only for when no SillyTavern is running to have a tab; with one running,
 * the tab is asked instead (`/proxy`). The edit touches what choosing a
 * preset in the page touches: `selected_proxy`, which the page reads back on
 * load as the preset to apply, and `oai_settings.reverse_proxy` and
 * `proxy_password`, which it then sets from it. `None` turns the proxy off.
 *
 * SillyTavern writes the file as `JSON.stringify(settings, null, 4)`. The
 * file is changed only when reading and writing it again that way gives back
 * exactly what is there, so nothing else in it moves; a file that was edited
 * by hand is refused rather than reformatted.
 */
export async function selectProxyOnDisk(userRoot: string, name: string): Promise<void> {
  const path = join(userRoot, SETTINGS_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new SettingsEditError('settings_missing', 'SillyTavern has not written its settings yet');
  }
  let settings: unknown;
  try { settings = JSON.parse(raw); } catch { settings = null; }
  if (!isRecord(settings) || JSON.stringify(settings, null, 4) !== raw) {
    throw new SettingsEditError('settings_not_round_trip', 'settings.json is not as SillyTavern writes it, so it is left alone');
  }
  const proxy = name === NO_PROXY
    ? { name: NO_PROXY, url: '', password: '' }
    : parseSettings(settings).proxies.find((item) => item.name === name);
  if (!proxy) throw new SettingsEditError('proxy_missing', 'That proxy is no longer in SillyTavern');
  settings.selected_proxy = { name: proxy.name, url: proxy.url, password: proxy.password };
  if (isRecord(settings.oai_settings)) {
    settings.oai_settings.reverse_proxy = proxy.url;
    settings.oai_settings.proxy_password = proxy.password;
  }
  const temporary = `${path}.stm-${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 4), 'utf8');
  await rename(temporary, path);
}

/** The secret name `/api <value>` reads its key from. */
export function secretKeyForApi(api: string): string {
  return `api_key_${connectionApiProvider(api)}`;
}

/**
 * A key as the page may see it: its first and last four characters.
 *
 * A key shorter than sixteen gives nothing away, since eight characters of
 * it would be half of it.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 16) return '••••••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * An address as the page may see it: scheme, host, port and path.
 *
 * A query and a user name or password are dropped, since a proxy is now and
 * then reached with a token in one of them. Null for anything that is not an
 * http or https address, and for nothing at all.
 */
export function shownAddress(value: string | null): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  return `${url.protocol}//${url.host}${path}`;
}

async function readJsonFile(path: string): Promise<Read<unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { unreadable: true };
  }
  // An empty file is what a write that was cut short leaves; it holds nothing.
  if (raw.trim() === '') return { missing: true };
  try {
    return { value: JSON.parse(raw.replace(/^\uFEFF/u, '')) as unknown };
  } catch {
    return { unreadable: true };
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
