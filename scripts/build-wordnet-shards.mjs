import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'node_modules', 'wordnet-db');
const outputRoot = join(projectRoot, 'public', 'dictionary');
const datasetVersion = '3.1';
const packageVersion = '3.1.14';
const sourceFiles = [
  ['data.noun', 'noun'],
  ['data.verb', 'verb'],
  ['data.adj', 'adjective'],
  ['data.adv', 'adverb'],
];

const entries = new Map();

for (const [fileName, partOfSpeech] of sourceFiles) {
  const contents = await readFile(join(sourceRoot, 'dict', fileName), 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    if (!/^\d{8}\s/.test(line)) continue;
    const separatorIndex = line.indexOf('|');
    if (separatorIndex < 0) continue;

    const fields = line.slice(0, separatorIndex).trim().split(/\s+/);
    const wordCount = Number.parseInt(fields[3] ?? '', 16);
    if (!Number.isFinite(wordCount) || wordCount < 1) continue;

    const definition = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/;\s*"[\s\S]*$/, '')
      .trim();
    if (!definition) continue;

    for (let index = 0; index < wordCount; index += 1) {
      const lemma = (fields[4 + index * 2] ?? '').toLowerCase();
      if (!/^[a-z]+(?:['-][a-z]+)*$/.test(lemma)) continue;
      const definitions = entries.get(lemma) ?? [];
      const duplicate = definitions.some(
        ([existingPartOfSpeech, existingDefinition]) =>
          existingPartOfSpeech === partOfSpeech && existingDefinition === definition,
      );
      if (!duplicate) definitions.push([partOfSpeech, definition]);
      entries.set(lemma, definitions);
    }
  }
}

const shards = new Map();
for (const lemma of [...entries.keys()].sort((first, second) =>
  first.localeCompare(second),
)) {
  const shardKey = getShardKey(lemma);
  const shardEntries = shards.get(shardKey) ?? {};
  shardEntries[lemma] = entries.get(lemma);
  shards.set(shardKey, shardEntries);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const shardMetadata = [];
let totalShardBytes = 0;
for (const [shardKey, shardEntries] of [...shards].sort(([first], [second]) =>
  first.localeCompare(second),
)) {
  const fileName = `${shardKey}.json`;
  const outputPath = join(outputRoot, fileName);
  await writeFile(outputPath, JSON.stringify({ entries: shardEntries }));
  const { size } = await stat(outputPath);
  totalShardBytes += size;
  shardMetadata.push({
    key: shardKey,
    bytes: size,
    entryCount: Object.keys(shardEntries).length,
  });
}

const totalDefinitions = [...entries.values()].reduce(
  (count, definitions) => count + definitions.length,
  0,
);
await writeFile(
  join(outputRoot, 'manifest.json'),
  JSON.stringify({
    formatVersion: 1,
    dataset: 'Princeton WordNet',
    datasetVersion,
    sourcePackage: 'wordnet-db',
    sourcePackageVersion: packageVersion,
    sourceUrl: 'https://wordnet.princeton.edu/',
    license: 'Princeton WordNet License',
    shardStrategy: 'first-two-letters',
    entryCount: entries.size,
    definitionCount: totalDefinitions,
    shardCount: shardMetadata.length,
    totalShardBytes,
    shards: shardMetadata,
  }),
);
await copyFile(join(sourceRoot, 'LICENSE'), join(outputRoot, 'WORDNET-LICENSE.txt'));

console.log(
  JSON.stringify(
    {
      entries: entries.size,
      definitions: totalDefinitions,
      shards: shardMetadata.length,
      totalShardBytes,
      largestShard: shardMetadata.reduce(
        (largest, shard) => (shard.bytes > largest.bytes ? shard : largest),
        { key: '', bytes: 0, entryCount: 0 },
      ),
      averageShardBytes: Math.round(totalShardBytes / shardMetadata.length),
    },
    null,
    2,
  ),
);

function getShardKey(word) {
  const letters = word.replace(/[^a-z]/g, '');
  return letters.length === 1 ? `${letters}_` : letters.slice(0, 2);
}
