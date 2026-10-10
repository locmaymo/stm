/**
 * How much of the end of a zip can hold where its directory is: the
 * end-of-central-directory record with the longest comment allowed after it,
 * and the ZIP64 record and locator a large archive puts in front of it.
 */
export const ZIP_TAIL_SEARCH_BYTES = 22 + 0xffff + 20 + 56;

/**
 * Where a zip's central directory starts, read from the end of the file.
 *
 * Saver mode restores a zip as it uploads, and the server needs the directory
 * before the first byte of the archive: it says what is in it, where each
 * entry starts and how long it is. The browser holds the whole file, so it can
 * cut that part out of the end and send it first.
 *
 * An archive past four gigabytes or 65,535 files keeps the real offset in a
 * ZIP64 record, which a locator just before the end record points at.
 *
 * `tail` is the last `ZIP_TAIL_SEARCH_BYTES` of the file, or the whole file
 * when it is shorter. Null for anything this cannot restore that way - not a
 * zip, or one whose records are not where a zip keeps them - which the server
 * would refuse anyway, and says why.
 */
export function centralDirectoryOffset(tail: Uint8Array, fileSize: number): number | null {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const tailStart = fileSize - tail.length;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) !== 0x06054b50) continue;
    const locator = index - 20;
    if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
      const record = Number(view.getBigUint64(locator + 8, true)) - tailStart;
      if (record < 0 || record + 56 > locator || view.getUint32(record, true) !== 0x06064b50) return null;
      const offset = Number(view.getBigUint64(record + 48, true));
      return Number.isSafeInteger(offset) && offset < fileSize ? offset : null;
    }
    const offset = view.getUint32(index + 16, true);
    if (offset === 0xffffffff || offset >= fileSize) return null;
    return offset;
  }
  return null;
}
