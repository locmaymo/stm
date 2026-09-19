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
  /*
   * The one queue every path writes the usage log through.
   *
   * There are three ways a request reaches the observer - the global `fetch`
   * above, the CJS bridge below, and the ESM hook's rewritten node-fetch - and
   * the third reads its options from here. Nothing ever put them here, so it
   * fell back to making a second write queue of its own, and two independent
   * queues appending to one file have no order between them: a call that had
   * already finished could be written after one that came later. It showed up
   * as a test failing on Windows about once in a while, which is what a race
   * looks like from the outside.
   */
  globalThis.__stmInstrumentationOptions = { persist };

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
