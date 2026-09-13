import type { LogEntry, MessageParams } from '../../../packages/contracts/src/index.js';

/** Remove the internal job prefix from messages before showing them to operators. */
export function formatLogMessage(message: string): string {
  return message.replace(/^\[(?:manager|sillytavern|cloudflared|installer|backup|config|profiles|r2|setup|telemetry)(?::[a-z0-9-]{16,})?\] ?/i, '');
}

/** Substitute `{name}` placeholders with the values the server sent. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([^{}]+)\}/gu, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * A log line in the reader's language.
 *
 * Only lines the manager wrote itself carry a catalog code. Output from
 * SillyTavern, cloudflared, npm and git arrives without one and is shown
 * exactly as that program wrote it - translating another project's output
 * would make it impossible to search for.
 */
export function translateLogEntry(entry: LogEntry, catalog: Record<string, unknown>): string {
  const template = entry.code === undefined ? undefined : lookup(catalog, entry.code);
  return template === undefined
    ? formatLogMessage(entry.message)
    : interpolate(template, entry.params);
}

/** The translation for a manager step, or its English text when there is none. */
export function translateStep(step: string, catalog: Record<string, unknown>, code?: string, params?: MessageParams): string {
  const template = code === undefined ? undefined : lookup(catalog, code);
  return template === undefined ? step : interpolate(template, params);
}

function lookup(catalog: Record<string, unknown>, code: string): string | undefined {
  let current: unknown = catalog;
  for (const part of code.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}
