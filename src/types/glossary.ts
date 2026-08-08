import type { NormalizedHighlightRectangle } from './highlight';

export interface DictionarySourceAttribution {
  dataset: 'Princeton WordNet';
  version: '3.1';
  license: 'Princeton WordNet License';
  sourceUrl: 'https://wordnet.princeton.edu/';
  partOfSpeech: DictionaryPartOfSpeech;
}

export type DictionaryPartOfSpeech = 'noun' | 'verb' | 'adjective' | 'adverb';

export interface DictionaryDefinition {
  id: string;
  text: string;
  partOfSpeech: DictionaryPartOfSpeech;
  source: DictionarySourceAttribution;
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
  glossaryEntryId?: string;
}

export type NotesPrintLayout = 'standard' | 'space-saving';
