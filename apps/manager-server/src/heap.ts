import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';

const MIB = 1024 * 1024;
/** More than this is more than any phone running SillyTavern has to spare. */
const ANDROID_CEILING_MB = 4096;
/** Below this SillyTavern does not finish starting. */
const SMALLEST_MB = 256;

/**
 * How much JavaScript memory SillyTavern may use, in MiB, or null for Node's
 * own choice.
 *
 * Node gives a process about a quarter of the machine's memory: 1,077 MiB on a
 * 4 GB phone, some 800 on a 3 GB one. SillyTavern reads a whole chat or its
 * whole settings file into memory and then writes it out again as JSON, and an
 * extension that keeps its data in the settings can make that file large, so
 * on a phone it ran out within a minute of starting - "Ineffective
 * mark-compacts near heap limit", then SIGABRT. The Android app now gives it
 * half of the phone's memory, never less than Node would and never more than
 * 4 GiB. A computer, and a hosted container whose memory is the whole budget,
 * keep Node's default.
 *
 * `STM_SILLYTAVERN_HEAP_MB` settles it anywhere. A size already given in
 * `NODE_OPTIONS` is somebody's choice and is left to stand.
 */
export function sillyTavernHeapMb(env: NodeJS.ProcessEnv, machine: { readonly totalBytes?: number; readonly defaultLimitBytes?: number } = {}): number | null {
  const asked = Number(env.STM_SILLYTAVERN_HEAP_MB);
  if (Number.isSafeInteger(asked) && asked >= SMALLEST_MB) return asked;
  if (/--max-old-space-size/u.test(env.NODE_OPTIONS ?? '')) return null;
  if (env.STM_ANDROID_APP !== '1') return null;
  const total = machine.totalBytes ?? totalmem();
  const floor = Math.ceil((machine.defaultLimitBytes ?? getHeapStatistics().heap_size_limit) / MIB);
  const heap = Math.min(Math.max(Math.floor(total / 2 / MIB), floor), ANDROID_CEILING_MB);
  return heap > floor ? heap : null;
}

/** What Node gives a process here when nothing is asked for, in MiB. */
export function defaultHeapMb(): number {
  return Math.round(getHeapStatistics().heap_size_limit / MIB);
}
