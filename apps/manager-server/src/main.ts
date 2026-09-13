import { startManagerServer } from './server.js';
import { ensurePanelBuilt, openInBrowser } from './bootstrap.js';

await ensurePanelBuilt();

const manager = await startManagerServer();
const url = `http://127.0.0.1:${manager.port}`;
console.log(`[manager] listening on ${url}`);

/**
 * Report a fault instead of letting it end the process in silence.
 *
 * Node ends the process on an unhandled rejection, and there was no handler
 * here, so one rejected promise anywhere - a background sweep, a failed
 * recovery after a failed install - closed the console and wrote nothing to
 * the log to say why. What the operator saw was SillyTavern unreachable, no
 * way to install a different version, and no record of the cause.
 *
 * The work that can damage data runs in the SillyTavern child, not here. The
 * manager's job after a fault is to still be there: to serve the console, to
 * show the line below, and to let a different version be installed.
 */
const reportFault = (kind: string, error: unknown): void => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  for (const line of detail.split('\n')) manager.logger(`[manager] ${kind}: ${line.trim()}`);
};

process.on('uncaughtException', (error: unknown) => { reportFault('uncaught exception', error); });
process.on('unhandledRejection', (reason: unknown) => { reportFault('unhandled rejection', reason); });

await openInBrowser(url, { logger: manager.logger });

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[manager] received ${signal}; shutting down`);
  await manager.close();
};

process.once('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});
