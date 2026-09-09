import { startManagerServer } from './server.js';

const manager = await startManagerServer();
console.log(`[manager] listening on http://127.0.0.1:${manager.port}`);

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
