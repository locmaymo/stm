/** Remove the internal job prefix from messages before showing them to operators. */
export function formatLogMessage(message: string): string {
  return message.replace(/^\[(?:manager|sillytavern|cloudflared|installer|backup)(?::[a-z0-9-]{16,})?\] ?/i, '');
}
