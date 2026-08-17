import type { NotesPrintLayout } from './glossary';

export interface PrintDraftAddition {
  id: string;
  kind: 'ai-result' | 'custom';
  label: string;
  content: string;
  createdAt: number;
}

export interface PrintDraftRecord {
  documentId: string;
  sourceFingerprint: string;
  sourceModelVersion: number;
  editorStateJson: string;
  layout: NotesPrintLayout;
  createdAt: number;
  updatedAt: number;
  lastSavedAt: number;
  pendingAdditions: PrintDraftAddition[];
}

export type AiMessageRole = 'user' | 'assistant';

export interface AiChatMessage {
  id: string;
  role: AiMessageRole;
  content: string;
  createdAt: number;
  status?: 'streaming' | 'complete' | 'error' | 'stopped';
  pages?: number[];
  contextCharacters?: number;
}

export interface AiConversationRecord {
  id: string;
  documentId: string;
  title: string;
  messages: AiChatMessage[];
  promptProfileId: string;
  createdAt: number;
  updatedAt: number;
}
