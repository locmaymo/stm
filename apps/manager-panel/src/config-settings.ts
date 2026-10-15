import type { ConfigSettings, ConfigSettingsInput } from '../../../packages/contracts/src/index.js';

/**
 * How long the settings card waits after a press before saving it.
 *
 * Saving restarts SillyTavern, so the wait is what lets three switches pressed
 * one after another go in one restart rather than three - and short enough
 * that somebody who presses one and leaves has it saved before they are gone.
 */
export const AUTOSAVE_DELAY_MS = 1200;

/**
 * What the switches say that the file does not, or null when nothing.
 *
 * Only what differs is sent, so a save never writes back a value the file
 * already holds - including one that changed in the file since the card read
 * it, by hand or by another console.
 */
export function changedSettings(desired: ConfigSettingsInput, saved: ConfigSettings): ConfigSettingsInput | null {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value !== undefined && value !== saved[key as keyof ConfigSettings]) changes[key] = value;
  }
  return Object.keys(changes).length > 0 ? changes as ConfigSettingsInput : null;
}

/**
 * Why this text is not a configuration file, or null when it could be one.
 *
 * The same two checks the manager makes before it writes - it parses, and it
 * is a mapping at the top - made here first, so a typo is pointed out in the
 * editor it was made in instead of after the editor has closed. The parser is
 * fetched the first time it is needed; nobody who never opens the editor
 * downloads it.
 *
 * `detail` is the parser's own account, with the line and column, and empty
 * where it has none to give.
 */
export async function yamlProblem(raw: string): Promise<{ readonly detail: string } | null> {
  const { parseDocument, isMap } = await import('yaml');
  const document = parseDocument(raw, { prettyErrors: true });
  const [first] = document.errors;
  if (first) return { detail: first.message };
  if (!isMap(document.contents)) return { detail: '' };
  return null;
}
