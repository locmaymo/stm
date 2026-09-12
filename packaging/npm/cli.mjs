#!/usr/bin/env node
/* global URL */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManagerServer } from './apps/manager-server/src/server.js';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
process.env.STM_STATIC_ROOT ??= join(packageRoot, 'panel');

const manager = await startManagerServer();
console.log(`[manager] listening on http://127.0.0.1:${manager.port}`);

const shutdown = async (signal) => {
  console.log(`[manager] received ${signal}; shutting down`);
  await manager.close();
};

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)));
