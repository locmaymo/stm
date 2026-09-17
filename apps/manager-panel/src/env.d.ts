/**
 * The panel's own version, replaced at build time by `vite.config.ts`.
 *
 * A constant rather than a value fetched from the manager: this names the
 * interface on screen, which is the artifact the browser just loaded, and it
 * has to be readable on the first-run screen before anything is signed in.
 */
declare const __STM_VERSION__: string;
