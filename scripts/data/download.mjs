import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POPULATION_SOURCE_BYTES,
  POPULATION_SOURCE_DOWNLOAD_URL,
  POPULATION_SOURCE_FILENAME,
  POPULATION_SOURCE_SHA256,
  SOURCE_BYTES,
  SOURCE_DOWNLOAD_URL,
  SOURCE_FILENAME,
  SOURCE_SHA256,
  VILLAGE_SOURCE_BYTES,
  VILLAGE_SOURCE_DOWNLOAD_URL,
  VILLAGE_SOURCE_FILENAME,
  VILLAGE_SOURCE_SHA256,
} from './source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawDir = resolve(repoRoot, 'data/raw');
const sources = [
  { filename: SOURCE_FILENAME, url: SOURCE_DOWNLOAD_URL, bytes: SOURCE_BYTES, sha256: SOURCE_SHA256 },
  {
    filename: VILLAGE_SOURCE_FILENAME,
    url: VILLAGE_SOURCE_DOWNLOAD_URL,
    bytes: VILLAGE_SOURCE_BYTES,
    sha256: VILLAGE_SOURCE_SHA256,
  },
  {
    filename: POPULATION_SOURCE_FILENAME,
    url: POPULATION_SOURCE_DOWNLOAD_URL,
    bytes: POPULATION_SOURCE_BYTES,
    sha256: POPULATION_SOURCE_SHA256,
  },
];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function matchesExpected(data, source) {
  return data.byteLength === source.bytes && sha256(data) === source.sha256;
}

await mkdir(rawDir, { recursive: true });

for (const source of sources) {
  const targetPath = resolve(rawDir, source.filename);
  try {
    const existing = await readFile(targetPath);
    if (matchesExpected(existing, source)) {
      process.stdout.write(`Raw source verified; skipping download (${source.filename}).\n`);
      continue;
    }
    process.stdout.write(`Cached ${source.filename} did not match the pinned hash; downloading a verified copy.\n`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${targetPath}.part-${process.pid}`;
  try {
    process.stdout.write(`Downloading ${source.url}\n`);
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    const actualSha = sha256(data);
    if (data.byteLength !== source.bytes || actualSha !== source.sha256) {
      throw new Error(
        `Downloaded ${source.filename} does not match the pinned source ` +
          `(expected ${source.bytes} bytes, SHA-256 ${source.sha256}; ` +
          `got ${data.byteLength} bytes, SHA-256 ${actualSha}). ` +
          'The source may have changed; verify it before updating scripts/data/source.mjs.',
      );
    }
    await writeFile(temporaryPath, data, { flag: 'wx' });
    await rename(temporaryPath, targetPath);
    process.stdout.write(`Downloaded and verified ${source.filename} (${source.bytes} bytes).\n`);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Unable to obtain verified source ${source.filename}: ${error.message}`, { cause: error });
  }
}
