import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const assetDirectory = resolve('dist', 'assets');
const bundleNames = (await readdir(assetDirectory)).filter((name) =>
  name.endsWith('.js'),
);
if (bundleNames.length === 0) {
  throw new Error('No production JavaScript bundles were found.');
}

const productionSource = (
  await Promise.all(
    bundleNames.map((name) => readFile(resolve(assetDirectory, name), 'utf8')),
  )
).join('\n');

const requiredCopy = [
  'Verify identity (read-only)',
  'Forget inaccessible paper',
  'exact account/root/document proof is not available yet',
  'No Google Drive object will be deleted or changed',
];
for (const value of requiredCopy) {
  if (!productionSource.includes(value)) {
    throw new Error(
      `The production paper-recovery UI is missing required copy: ${value}`,
    );
  }
}

const developmentOnlyCopy = [
  'Failed predicate:',
  'Targeted purge visibility predicate matrix',
];
for (const value of developmentOnlyCopy) {
  if (productionSource.includes(value)) {
    throw new Error(
      `Development-only paper-recovery diagnostics leaked into production: ${value}`,
    );
  }
}

console.log(
  `Verified production paper recovery UI across ${bundleNames.length} JavaScript bundles.`,
);
