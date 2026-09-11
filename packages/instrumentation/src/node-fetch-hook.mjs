/* global URL */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (specifier !== 'node-fetch') return resolved;
  return { url: `stm-instrumented:${encodeURIComponent(resolved.url)}`, shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('stm-instrumented:')) return nextLoad(url, context);
  const originalUrl = decodeURIComponent(url.slice('stm-instrumented:'.length));
  const observerUrl = new URL('./observer.mjs', import.meta.url).href;
  const source = `import * as original from ${JSON.stringify(originalUrl)};\nimport { installFetchObserver } from ${JSON.stringify(observerUrl)};\nconst wrapped = installFetchObserver(original.default, globalThis.__stmInstrumentationOptions ?? {});\nexport * from ${JSON.stringify(originalUrl)};\nexport { wrapped as default };\n`;
  return { format: 'module', source, shortCircuit: true };
}
