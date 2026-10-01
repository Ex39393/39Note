/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_39NOTE_SYNC_AUTH_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'pdfjs-dist/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
