import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'node_modules', 'wordnet-db', 'dict');
const outputRoot = join(projectRoot, 'public', 'dictionary');
const outputPath = join(outputRoot, 'pdf-source-lexicon.bin');
const sourceFiles = ['data.noun', 'data.verb', 'data.adj', 'data.adv'];
const magic = Buffer.from('39NLX001', 'ascii');
const bitCount = 1 << 21;
const hashCount = 10;
const headerBytes = 20;
const words = new Set();

for (const fileName of sourceFiles) {
  const contents = await readFile(join(sourceRoot, fileName), 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    if (!/^\d{8}\s/.test(line)) continue;
    const separatorIndex = line.indexOf('|');
    if (separatorIndex < 0) continue;

    const fields = line.slice(0, separatorIndex).trim().split(/\s+/);
    const wordCount = Number.parseInt(fields[3] ?? '', 16);
    if (!Number.isFinite(wordCount) || wordCount < 1) continue;

    for (let index = 0; index < wordCount; index += 1) {
      const lemma = (fields[4 + index * 2] ?? '').toLowerCase();
      if (/^[a-z]+(?:['-][a-z]+)*$/.test(lemma)) words.add(lemma);
    }
  }
}

const bytes = Buffer.alloc(headerBytes + bitCount / 8);
magic.copy(bytes, 0);
bytes.writeUInt32LE(bitCount, 8);
bytes.writeUInt32LE(hashCount, 12);
bytes.writeUInt32LE(words.size, 16);

for (const word of words) {
  const [firstHash, secondHash] = getBloomHashes(word);
  for (let index = 0; index < hashCount; index += 1) {
    const bitIndex = (firstHash + Math.imul(index, secondHash)) & (bitCount - 1);
    bytes[headerBytes + (bitIndex >>> 3)] |= 1 << (bitIndex & 7);
  }
}

await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, bytes);

console.log(JSON.stringify({
  outputPath,
  entries: words.size,
  bitCount,
  hashCount,
  bytes: bytes.length,
}, null, 2));

function getBloomHashes(value) {
  const firstHash = fnv1a(value, 0x811c9dc5);
  let secondHash = fnv1a(value, 0x9e3779b9) | 1;
  if (secondHash === 0) secondHash = 0x27d4eb2d;
  return [firstHash, secondHash];
}

function fnv1a(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  return hash >>> 0;
}
