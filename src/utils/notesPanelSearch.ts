import { isPdfGlossaryEntry, type GlossaryEntry } from '../types/glossary.ts';
import type { Note } from '../types/note.ts';

export function getGlossaryLocationLabel(entry: GlossaryEntry): string {
  return isPdfGlossaryEntry(entry) ? `Page ${entry.pageNumber}` : entry.locationLabel;
}

export function noteMatchesSearch(note: Note, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return true;

  return [note.content, note.displayNumber].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function glossaryEntryMatchesSearch(
  entry: GlossaryEntry,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return true;

  return [entry.displayedWord, entry.definition, getGlossaryLocationLabel(entry)].some(
    (value) => value.toLocaleLowerCase().includes(normalizedQuery),
  );
}
