import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { logEvent, logLineText, type Installation, type LogSink, type Profile } from '../../../packages/contracts/src/index.js';
import { ioConcurrency, runPooled } from '../../../packages/platform/src/index.js';
import type { ConfigStore } from '../../../packages/config/src/index.js';

/**
 * A profile with this many character cards, or this much in them, is opened
 * with SillyTavern's lazy loading on.
 *
 * Without it the character list is every card in full - a profile of 1,170
 * cards sent 607 MB of JSON for it, and the page waited most of a minute -
 * where with it the list is names and pictures, and a card is read when it is
 * opened.
 */
export const LAZY_LOAD_MIN_CHARACTERS = 300;
export const LAZY_LOAD_MIN_BYTES = 100 * 1024 * 1024;

const STATE_SCHEMA_VERSION = 1 as const;

export interface CharacterShelf {
  readonly count: number;
  readonly bytes: number;
}

interface LazyLoadState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  /** Profiles already looked at once lazy loading was on for them; they are not touched again. */
  readonly decided: readonly string[];
}

export interface LargeProfileLazyLoadOptions {
  /** Where the profiles already decided on are remembered. */
  readonly file: string;
  readonly config: Pick<ConfigStore, 'read' | 'update'>;
  /** The profile's own SillyTavern user directory, where `characters` is. */
  readonly userRoot: (profile: Profile) => string;
  readonly logger?: LogSink;
}

/**
 * Turns lazy loading on, once, for a profile with a great many characters.
 *
 * Once per profile, and only on: a profile that has had it on - turned on
 * here or by its owner - is remembered, so turning it off again in the
 * console is a choice that stays made. A profile too small for it is asked
 * again on a later start, since it may have grown.
 */
export class LargeProfileLazyLoad {
  private readonly file: string;
  private readonly config: Pick<ConfigStore, 'read' | 'update'>;
  private readonly userRoot: (profile: Profile) => string;
  private readonly logger: LogSink;

  public constructor(options: LargeProfileLazyLoadOptions) {
    this.file = options.file;
    this.config = options.config;
    this.userRoot = options.userRoot;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
  }

  /** Before SillyTavern starts on `profile`. Returns whether the config was changed. */
  public async apply(profile: Profile, installation: Installation): Promise<boolean> {
    const decided = await this.readDecided();
    if (decided.has(profile.id)) return false;
    const current = await this.config.read(profile, installation);
    if (current.settings.lazyLoadCharacters) {
      await this.remember(decided, profile.id);
      return false;
    }
    const shelf = await measureCharacters(join(this.userRoot(profile), 'characters'));
    if (shelf.count < LAZY_LOAD_MIN_CHARACTERS && shelf.bytes < LAZY_LOAD_MIN_BYTES) return false;
    await this.config.update(profile, installation, { settings: { lazyLoadCharacters: true } });
    await this.remember(decided, profile.id);
    const size = `${Math.round(shelf.bytes / (1024 * 1024))} MB`;
    this.logger(logEvent('config.lazyLoadLarge', `[config] turned on lazy loading of characters for ${profile.name}: it has ${shelf.count} character cards (${size}); it can be turned off in the console and stays off`, { name: profile.name, count: shelf.count, size }));
    return true;
  }

  private async readDecided(): Promise<Set<string>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LazyLoadState>;
      return new Set(parsed.schemaVersion === STATE_SCHEMA_VERSION && Array.isArray(parsed.decided) ? parsed.decided.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private async remember(decided: Set<string>, profileId: string): Promise<void> {
    const state: LazyLoadState = { schemaVersion: STATE_SCHEMA_VERSION, decided: [...decided, profileId] };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }
}

/**
 * The character cards in `directory`: the PNG and JSON files directly in it.
 *
 * Not its folders, which hold each character's expression sprites rather than
 * cards. A missing directory is an empty shelf.
 */
export async function measureCharacters(directory: string): Promise<CharacterShelf> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return { count: 0, bytes: 0 }; }
  const cards = entries.filter((entry) => entry.isFile() && ['.png', '.json'].includes(extname(entry.name).toLowerCase()));
  let bytes = 0;
  await runPooled(cards, ioConcurrency(), async (entry) => {
    // Read before adding: `bytes += await ...` would add to the total as it
    // stood before the wait, and lose what the other stats added meanwhile.
    try { const { size } = await stat(join(directory, entry.name)); bytes += size; } catch { /* gone since the listing */ }
  });
  return { count: cards.length, bytes };
}
