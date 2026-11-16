import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, 'public/icons');

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, typeBytes, data, crc]);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pixel(x, y, size) {
  const scale = size / 192;
  const cx = size / 2;
  const cy = size / 2;
  let color = [244, 246, 248, 255];
  const tileHalf = 70 * scale;
  if (Math.abs(x - cx) <= tileHalf && Math.abs(y - cy) <= tileHalf) color = [43, 66, 79, 255];

  const track = (offset) => Math.abs((y - cy) - 0.62 * (x - cx) - offset * scale) <= 5 * scale;
  if ((track(-24) || track(0) || track(24)) && Math.abs(x - cx) < 47 * scale) color = [221, 235, 233, 255];

  const markX = cx + 39 * scale;
  const markY = cy - 39 * scale;
  if ((x - markX) ** 2 + (y - markY) ** 2 <= (10 * scale) ** 2) color = [225, 154, 96, 255];
  return color;
}

function createPng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    rows[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      const rgba = pixel(x, y, size);
      rows.set(rgba, offset);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outputDirectory, { recursive: true });
for (const size of [192, 512]) {
  await writeFile(resolve(outputDirectory, `icon-${size}.png`), createPng(size));
}
