import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_BYTES,
  SOURCE_DOWNLOAD_URL,
  SOURCE_FILENAME,
  SOURCE_SHA256,
} from './source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawDir = resolve(repoRoot, 'data/raw');
const targetPath = resolve(rawDir, SOURCE_FILENAME);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function matchesExpected(data) {
  return data.byteLength === SOURCE_BYTES && sha256(data) === SOURCE_SHA256;
}

await mkdir(rawDir, { recursive: true });

try {
  const existing = await readFile(targetPath);
  if (matchesExpected(existing)) {
    process.stdout.write(`Raw source verified; skipping download (${SOURCE_FILENAME}).\n`);
    process.exit(0);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const temporaryPath = `${targetPath}.part-${process.pid}`;
try {
  process.stdout.write(`Downloading ${SOURCE_DOWNLOAD_URL}\n`);
  const response = await fetch(SOURCE_DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const actualSha = sha256(data);
  if (data.byteLength !== SOURCE_BYTES || actualSha !== SOURCE_SHA256) {
    throw new Error(
      `Downloaded source does not match the pinned archive ` +
        `(bytes ${data.byteLength}, SHA-256 ${actualSha}). ` +
        `If the source has been updated, verify it and update SOURCE_BYTES and SOURCE_SHA256 in scripts/data/source.mjs.`,
    );
  }
  await writeFile(temporaryPath, data, { flag: 'wx' });
  await rename(temporaryPath, targetPath);
  process.stdout.write(`Downloaded and verified ${SOURCE_FILENAME} (${SOURCE_BYTES} bytes).\n`);
} catch (error) {
  await rm(temporaryPath, { force: true });
  throw new Error(`Unable to obtain verified source archive: ${error.message}`, { cause: error });
}
