/**
 * How much of the end of a zip can hold its end-of-central-directory record:
 * the record itself and the longest comment allowed after it.
 */
export const ZIP_TAIL_SEARCH_BYTES = 22 + 0xffff;

/**
 * Where a zip's central directory starts, read from the end of the file.
 *
 * Saver mode restores a zip as it uploads, and the server needs the directory
 * before the first byte of the archive: it says what is in it, where each
 * entry starts and how long it is. The browser holds the whole file, so it can
 * cut that part out of the end and send it first.
 *
 * `tail` is the last `ZIP_TAIL_SEARCH_BYTES` of the file, or the whole file
 * when it is shorter. Null for anything this cannot restore that way - not a
 * zip, or a ZIP64 one - which the server would refuse anyway, and says why.
 */
export function centralDirectoryOffset(tail: Uint8Array, fileSize: number): number | null {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) !== 0x06054b50) continue;
    const entries = view.getUint16(index + 10, true);
    const offset = view.getUint32(index + 16, true);
    if (entries === 0xffff || offset === 0xffffffff || offset >= fileSize) return null;
    return offset;
  }
  return null;
}
