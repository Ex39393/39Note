import type { NormalizedHighlightRectangle } from './highlight';

export type DictionaryProvider = 'wordnet' | 'wiktionary' | 'mesh';

export interface WordNetSourceAttribution {
  provider?: 'wordnet';
  dataset: 'Princeton WordNet';
  version: '3.1';
  license: 'Princeton WordNet License';
  sourceUrl: 'https://wordnet.princeton.edu/';
  partOfSpeech: DictionaryPartOfSpeech;
}

export interface WiktionarySourceAttribution {
  provider: 'wiktionary';
  dataset: 'English Wiktionary';
  version: 'structured-definitions-v1';
  license: 'CC BY-SA 4.0 / GFDL';
  sourceUrl: 'https://en.wiktionary.org/';
  partOfSpeech?: string;
  domain?: string;
  sourceId?: string;
}

export interface MeshSourceAttribution {
  provider: 'mesh';
  dataset: 'NLM MeSH';
  version: string;
  license: 'NLM MeSH Terms and Conditions';
  sourceUrl: 'https://www.nlm.nih.gov/mesh/';
  domain: 'Biomedical terminology';
  sourceId: string;
  preferredHeading: string;
}

export type DictionarySourceAttribution =
  | WordNetSourceAttribution
  | WiktionarySourceAttribution
  | MeshSourceAttribution;

export type DictionaryPartOfSpeech = 'noun' | 'verb' | 'adjective' | 'adverb';

export interface DictionaryDefinition {
  id: string;
  text: string;
  partOfSpeech?: string;
  source: DictionarySourceAttribution;
}

export interface DictionaryLookupResult {
  normalizedWord: string;
  definitions: DictionaryDefinition[];
}

export interface GlossaryEntry {
  glossaryEntryId: string;
  documentId: string;
  displayedWord: string;
  normalizedLookupWord: string;
  definition: string;
  pageNumber: number;
  sourceRects: NormalizedHighlightRectangle[];
  startOffset: number;
  endOffset: number;
  createdAt: number;
  source: DictionarySourceAttribution;
  markerAnnotationId: string;
}

export type DefinitionBubbleStatus = 'loading' | 'ready' | 'not-found' | 'error';

export interface DefinitionBubble {
  id: string;
  documentId: string;
  pageNumber: number;
  displayedWord: string;
  normalizedLookupWord: string;
  rects: NormalizedHighlightRectangle[];
  startOffset: number;
  endOffset: number;
  definitions: DictionaryDefinition[];
  status: DefinitionBubbleStatus;
  isExpanded: boolean;
  isEnriching?: boolean;
  userHasReordered?: boolean;
  glossaryEntryId?: string;
  addedConfirmationToken?: number;
}

export const notesPrintLayouts = ['standard', 'space-saving', 'extra-large'] as const;

export type NotesPrintLayout = (typeof notesPrintLayouts)[number];
