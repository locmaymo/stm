/**
 * Generate the manager's brand assets from one square source image.
 *
 * The artwork is the STVN mark, which is a raster illustration - a brain, the
 * letters ST, and the Vietnamese flag badge - so there is no honest vector of
 * it to ship. Instead the source is resized once, here, into the exact sizes a
 * browser, an installed web app, and iOS each ask for, and the results are
 * committed. Nothing is fetched at build time and no image library is added to
 * the dependency tree; the decoder and encoder below are the only ones needed.
 *
 * Usage:
 *   node scripts/build-brand-assets.mjs [source.png]
 *
 * The default source is the STVN logo inside a sibling SillyTavern checkout.
 * Re-run it only when the artwork changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(repositoryRoot, 'apps', 'manager-panel', 'public');
const defaultSource = resolve(repositoryRoot, '..', 'st-web', 'SillyTavern', 'public', 'img', 'stvn-logo-transparent.png');

/** The disc colour behind the mark, for icons that may not be transparent. */
const PLATE = [0x3a, 0x1b, 0x18, 0xff];

// ---------------------------------------------------------------- decoding

/** Decode an 8-bit PNG into straight RGBA. Enough for the one file read here. */
function decodePng(path) {
  const buffer = readFileSync(path);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG sources are not supported');
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const planar = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const row = planar.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? planar.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior[x];
      const upLeft = x >= channels ? prior[x - channels] : 0;
      row[x] = (line[x] + reconstruct(filter, left, up, upLeft)) & 0xff;
    }
  }
  return { width, height, pixels: toRgba(planar, width, height, channels) };
}

function reconstruct(filter, left, up, upLeft) {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >> 1;
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toCorner = Math.abs(estimate - upLeft);
      return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : upLeft;
    }
    default: throw new Error(`unsupported scanline filter ${filter}`);
  }
}

function toRgba(planar, width, height, channels) {
  if (channels === 4) return planar;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels;
    const to = index * 4;
    const grey = channels <= 2;
    rgba[to] = grey ? planar[from] : planar[from];
    rgba[to + 1] = grey ? planar[from] : planar[from + 1];
    rgba[to + 2] = grey ? planar[from] : planar[from + 2];
    rgba[to + 3] = channels === 2 ? planar[from + 1] : channels === 4 ? planar[from + 3] : 0xff;
  }
  return rgba;
}

// ---------------------------------------------------------------- geometry

/** The tightest box that still holds every pixel the eye can see. */
function contentBounds(image, threshold = 8) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('the source image is fully transparent');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Resize a region into a square of `size`, averaging over premultiplied alpha.
 *
 * Averaging straight RGBA darkens every edge against transparency, which on a
 * 32px favicon is the difference between a crisp ring and a muddy one.
 */
function resample(image, region, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = Math.max(region.width, region.height) / size;
  const padX = (size * scale - region.width) / 2;
  const padY = (size * scale - region.height) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = region.x - padX + x * scale;
      const y0 = region.y - padY + y * scale;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y0 + scale); sy += 1) {
        if (sy < 0 || sy >= image.height) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x0 + scale); sx += 1) {
          if (sx < 0 || sx >= image.width) continue;
          const at = (sy * image.width + sx) * 4;
          const a = image.pixels[at + 3] / 255;
          red += image.pixels[at] * a;
          green += image.pixels[at + 1] * a;
          blue += image.pixels[at + 2] * a;
          alpha += a;
          weight += 1;
        }
      }
      const to = (y * size + x) * 4;
      if (weight === 0 || alpha === 0) continue;
      out[to] = Math.round(red / alpha);
      out[to + 1] = Math.round(green / alpha);
      out[to + 2] = Math.round(blue / alpha);
      out[to + 3] = Math.round((alpha / weight) * 255);
    }
  }
  return { width: size, height: size, pixels: out };
}

/** Lay a square image on an opaque plate, optionally inset, for icons that cannot be transparent. */
function onPlate(image, size, inset, plate) {
  const out = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    out.set(plate, index * 4);
  }
  const inner = Math.round(size * (1 - inset * 2));
  const scaled = resample(image, { x: 0, y: 0, width: image.width, height: image.height }, inner);
  const origin = Math.round((size - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const from = (y * inner + x) * 4;
      const alpha = scaled.pixels[from + 3] / 255;
      if (alpha === 0) continue;
      const to = ((y + origin) * size + x + origin) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        out[to + channel] = Math.round(scaled.pixels[from + channel] * alpha + out[to + channel] * (1 - alpha));
      }
      out[to + 3] = 0xff;
    }
  }
  return { width: size, height: size, pixels: out };
}

// ---------------------------------------------------------------- encoding

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An ICO holding PNG entries, which every browser the manager targets reads. */
function encodeIco(images) {
  const encoded = images.map((image) => encodePng(image));
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    directory[at] = image.width >= 256 ? 0 : image.width;
    directory[at + 1] = image.height >= 256 ? 0 : image.height;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(encoded[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += encoded[index].length;
  });
  return Buffer.concat([directory, ...encoded]);
}

// ---------------------------------------------------------------- entry

const sourcePath = resolve(process.argv[2] ?? defaultSource);
const source = decodePng(sourcePath);
const bounds = contentBounds(source);
mkdirSync(outputRoot, { recursive: true });

const write = (name, buffer) => {
  writeFileSync(join(outputRoot, name), buffer);
  console.log(`[brand] ${name} (${buffer.length.toLocaleString()} bytes)`);
};

const square = (size) => resample(source, bounds, size);

write('brand-mark.png', encodePng(square(256)));
write('icon-192.png', encodePng(square(192)));
write('icon-512.png', encodePng(square(512)));
write('icon-maskable-512.png', encodePng(onPlate(square(512), 512, 0.12, PLATE)));
write('apple-touch-icon.png', encodePng(onPlate(square(180), 180, 0.06, PLATE)));
write('favicon.ico', encodeIco([square(16), square(32), square(48)]));

console.log(`[brand] built from ${sourcePath}`);
