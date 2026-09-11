/* global URL */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Module, register } from 'node:module';
import { installFetchObserver } from './observer.mjs';

const marker = Symbol.for('sillytavern-manager.instrumentation');
const metricsFile = typeof process.env.STM_METRICS_FILE === 'string' && process.env.STM_METRICS_FILE.length > 0
  ? process.env.STM_METRICS_FILE
  : null;

if (!globalThis[marker]) {
  globalThis[marker] = true;
  const persist = createPersist(metricsFile);
  globalThis.fetch = installFetchObserver(globalThis.fetch, { persist });

  // SillyTavern imports node-fetch directly. The ESM hook covers node-fetch v3;
  // this CJS bridge keeps older releases observable too.
  const originalLoad = Module._load;
  Module._load = function managerInstrumentedLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== 'node-fetch' || typeof loaded !== 'function') return loaded;
    return installFetchObserver(loaded, { persist });
  };
  register(new URL('./node-fetch-hook.mjs', import.meta.url), { parentURL: import.meta.url });
}

function createPersist(file) {
  let writeQueue = Promise.resolve();
  return (event) => {
    if (!file) return;
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => undefined);
  };
}
