import { getSafeLookupCandidates } from './dictionary.ts';

const LEXICON_PATH = 'dictionary/pdf-source-lexicon.bin';
const MAGIC = '39NLX001';
const HEADER_BYTES = 20;

const EXPLICIT_WORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'am',
  'an',
  'and',
  'another',
  'any',
  'are',
  'as',
  'at',
  'background',
  'be',
  'based',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'condition',
  'could',
  'did',
  'do',
  'does',
  'each',
  'either',
  'evidence',
  'evidence-based',
  'factual',
  'few',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'long-term',
  'may',
  'me',
  'more',
  'most',
  'must',
  'my',
  'no',
  'nor',
  'not',
  'notebook',
  'of',
  'on',
  'one',
  'or',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'psychology',
  'question',
  'questions',
  'same',
  'she',
  'should',
  'some',
  'something',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'then',
  'there',
  'therefore',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'under',
  'up',
  'us',
  'was',
  'we',
  'well-being',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
]);

interface BloomLexicon {
  bits: Uint8Array;
  bitCount: number;
  hashCount: number;
  entryCount: number;
}

let bloomLexicon: BloomLexicon | null = null;
let lexiconPromise: Promise<void> | null = null;

export type PdfLexicalConfidence = 0 | 2 | 3 | 4;

export function getPdfLexicalConfidence(value: string): PdfLexicalConfidence {
  const word = value.toLocaleLowerCase('en-US');
  if (!/^[a-z]+(?:['-][a-z]+)*$/u.test(word)) return 0;
  if (EXPLICIT_WORDS.has(word)) return 4;
  if (bloomLexicon && bloomContains(bloomLexicon, word)) return 3;

  for (const candidate of getSafeLookupCandidates(word).slice(1)) {
    if (EXPLICIT_WORDS.has(candidate)) return 2;
    if (bloomLexicon && bloomContains(bloomLexicon, candidate)) return 2;
  }
  return 0;
}

export function isPdfSourceLexiconReady(): boolean {
  return bloomLexicon !== null;
}

export function preloadPdfSourceLexicon(): Promise<void> {
  if (bloomLexicon || typeof window === 'undefined') return Promise.resolve();
  if (lexiconPromise) return lexiconPromise;

  const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
  lexiconPromise = fetch(new URL(LEXICON_PATH, baseUrl))
    .then((response) => {
      if (!response.ok) {
        throw new Error(`PDF source lexicon request failed (${response.status}).`);
      }
      return response.arrayBuffer();
    })
    .then((bytes) => {
      installPdfSourceLexicon(bytes);
    })
    .catch(() => undefined);
  return lexiconPromise;
}

export function installPdfSourceLexicon(value: ArrayBuffer | Uint8Array): void {
  const bytes = value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error('PDF source lexicon is truncated.');
  }

  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bitCount = view.getUint32(8, true);
  const hashCount = view.getUint32(12, true);
  const entryCount = view.getUint32(16, true);
  if (
    magic !== MAGIC ||
    bitCount === 0 ||
    (bitCount & (bitCount - 1)) !== 0 ||
    hashCount < 1 ||
    hashCount > 32 ||
    bytes.byteLength !== HEADER_BYTES + bitCount / 8
  ) {
    throw new Error('PDF source lexicon header is invalid.');
  }

  bloomLexicon = {
    bits: bytes.slice(HEADER_BYTES),
    bitCount,
    hashCount,
    entryCount,
  };
}

export function getPdfSourceLexiconEntryCount(): number {
  return bloomLexicon?.entryCount ?? 0;
}

function bloomContains(lexicon: BloomLexicon, value: string): boolean {
  const [firstHash, secondHash] = getBloomHashes(value);
  for (let index = 0; index < lexicon.hashCount; index += 1) {
    const bitIndex = (
      firstHash + Math.imul(index, secondHash)
    ) & (lexicon.bitCount - 1);
    if ((lexicon.bits[bitIndex >>> 3] & (1 << (bitIndex & 7))) === 0) {
      return false;
    }
  }
  return true;
}

function getBloomHashes(value: string): [number, number] {
  const firstHash = fnv1a(value, 0x811c9dc5);
  let secondHash = fnv1a(value, 0x9e3779b9) | 1;
  if (secondHash === 0) secondHash = 0x27d4eb2d;
  return [firstHash, secondHash];
}

function fnv1a(value: string, seed: number): number {
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
