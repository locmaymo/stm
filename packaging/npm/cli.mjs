#!/usr/bin/env node
/* global URL */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkHost, startManagerServer } from './apps/manager-server/src/server.js';
import { bootstrapBanner } from './apps/manager-server/src/banner.js';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
process.env.STM_STATIC_ROOT ??= join(packageRoot, 'panel');

const manager = await startManagerServer();

// The same banner the checkout prints. This is the entry an installed copy
// runs, so it is the one that most needs to say where the console is.
const persisted = await manager.store.getPersisted();
const lan = await networkHost();
const lanUrl = lan ? `http://${lan}:${manager.port}` : undefined;
console.log(bootstrapBanner({
  title: `ST Manager ${persisted.managerVersion}`,
  addresses: [
    { label: 'On this computer', url: `http://127.0.0.1:${manager.port}` },
    ...(lanUrl ? [{ label: 'On this Wi-Fi', url: lanUrl }] : []),
  ],
  ...(lanUrl ? { qr: { value: lanUrl, caption: 'Scan to open on a phone' } } : {}),
  stopHint: 'Press Ctrl+C to stop.',
  colour: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
  ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
}));

const shutdown = async (signal) => {
  console.log(`[manager] received ${signal}; shutting down`);
  await manager.close();
};

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)));
