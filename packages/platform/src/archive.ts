import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform as TransformStream, type Transform } from 'node:stream';
import * as zlib from 'node:zlib';

/**
 * A directory tree as one compressed tar file, and back.
 *
 * For network storage, where one large file goes at the network's full speed
 * and thousands of small ones each cost a round trip. The tar program does
 * the walking; this only compresses, which Node does without anything to
 * install.
 */

export type ArchiveFormat = 'zst' | 'gz';

/**
 * How much is read or written at a time.
 *
 * Node's default of 64 KiB turns a pack of a few gigabytes into tens of
 * thousands of requests on network storage, and went at a quarter of the
 * speed the same storage gives to large reads and writes.
 */
const IO_CHUNK_BYTES = 8 * 1024 * 1024;

/** Gather what passes through into pieces of `IO_CHUNK_BYTES`, so each write is a large one. */
function coalesce(): Transform {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  return new TransformStream({
    transform(chunk: Buffer, _encoding, callback) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= IO_CHUNK_BYTES) {
        this.push(Buffer.concat(pending, pendingBytes));
        pending = [];
        pendingBytes = 0;
      }
      callback();
    },
    flush(callback) {
      if (pendingBytes > 0) this.push(Buffer.concat(pending, pendingBytes));
      callback();
    },
  });
}

interface ZstdZlib {
  readonly createZstdCompress?: (options?: { params?: Record<number, number> }) => Transform;
  readonly createZstdDecompress?: () => Transform;
}

/** Zstandard where this Node has it, which is faster both ways; gzip otherwise. */
export function archiveFormat(): ArchiveFormat {
  return typeof (zlib as ZstdZlib).createZstdCompress === 'function' ? 'zst' : 'gz';
}

function compressor(format: ArchiveFormat): Transform {
  const zstd = (zlib as ZstdZlib).createZstdCompress;
  // The fastest level: most of what is packed is images and code that is
  // already compressed or small, and the time is better spent sending it.
  const level = (zlib.constants as unknown as Record<string, number | undefined>).ZSTD_c_compressionLevel;
  if (format === 'zst' && zstd) return zstd(level === undefined ? {} : { params: { [level]: 1 } });
  return zlib.createGzip({ level: 1 });
}

function decompressor(format: ArchiveFormat): Transform {
  if (format === 'gz') return zlib.createGunzip();
  const zstd = (zlib as ZstdZlib).createZstdDecompress;
  if (!zstd) throw new Error('this Node cannot read a Zstandard archive');
  return zstd();
}

/**
 * A path as `tar` should be given it. Forward slashes on Windows, where the
 * tar first on the path may be a POSIX one that reads a backslash as an
 * escape; Windows' own tar takes them as well.
 */
function tarPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/gu, '/') : path;
}

/** Start `tar` with `args`; `done` settles when it exits, rejecting with what it said if it failed. */
function startTar(args: readonly string[], withInput: boolean): { child: ChildProcess; done: Promise<void> } {
  const child = spawn('tar', [...args], { stdio: [withInput ? 'pipe' : 'ignore', withInput ? 'ignore' : 'pipe', 'pipe'], windowsHide: true });
  let errorText = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-2000); });
  const done = new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code ?? 'a signal'}${errorText.trim() ? `: ${errorText.trim()}` : ''}`)));
  });
  return { child, done };
}

/**
 * Pack `root` into `target`, and say how many bytes the archive came to.
 *
 * Everything under `root`, or only `files` - paths relative to it, with
 * forward slashes - when they are given. A file that cannot be read fails the
 * whole pack, so a caller that may race with deletions checks and asks again.
 */
export async function packTree(root: string, target: string, format: ArchiveFormat, files?: readonly string[]): Promise<number> {
  let list: string | null = null;
  try {
    if (files) {
      list = join(tmpdir(), `stm-tar-list-${randomBytes(6).toString('hex')}`);
      await writeFile(list, files.map((file) => `${file}\0`).join(''), { mode: 0o600 });
    }
    const args = ['-C', tarPath(root), '-cf', '-', ...(list ? ['--null', '-T', tarPath(list)] : ['.'])];
    const tar = startTar(args, false);
    if (!tar.child.stdout) throw new Error('tar gave no output');
    await Promise.all([pipeline(tar.child.stdout, compressor(format), coalesce(), createWriteStream(target, { mode: 0o600, highWaterMark: IO_CHUNK_BYTES })), tar.done]);
    return (await stat(target)).size;
  } catch (error: unknown) {
    await rm(target, { force: true });
    throw error;
  } finally {
    if (list) await rm(list, { force: true });
  }
}

/**
 * Unpack `source` into `directory`, over whatever is there.
 *
 * Whether it worked is tar's to say. tar stops reading at the end of the
 * archive, and the zero padding that follows may still be on its way when it
 * exits; feeding it in large pieces, that arrives as a pipe closed early. A
 * tar that exited cleanly has unpacked everything, so that is not a failure.
 * Anything else that goes wrong on the way in - a pack that will not
 * decompress, one that cannot be read - still is.
 */
export async function unpackTree(source: string, format: ArchiveFormat, directory: string): Promise<void> {
  const unpacked = decompressor(format);
  const tar = startTar(['-C', tarPath(directory), '-xf', '-'], true);
  if (!tar.child.stdin) throw new Error('tar took no input');
  const fed = pipeline(createReadStream(source, { highWaterMark: IO_CHUNK_BYTES }), unpacked, tar.child.stdin).then(() => null, (error: unknown) => error);
  const [failure] = await Promise.all([fed, tar.done]);
  if (failure !== null && !closedEarly(failure)) throw failure;
}

/** What writing to a reader that has already stopped reading looks like. */
function closedEarly(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED' || code === 'EOF';
}
