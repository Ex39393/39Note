import type { OoxmlImageResource } from '../ooxml/package';

export interface DocxTextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly fontFamily?: string;
  readonly fontSizePoints?: number;
}

export interface DocxTextRun {
  readonly index: number;
  readonly text: string;
  readonly style: DocxTextStyle;
  readonly hyperlink?: string;
}

export interface DocxInlineImage {
  readonly relationshipId: string;
  readonly resource: OoxmlImageResource;
  readonly altText?: string;
}

export interface DocxParagraphBlock {
  readonly kind: 'paragraph';
  readonly id: string;
  readonly index: number;
  readonly structuralPath: readonly number[];
  readonly text: string;
  readonly runs: readonly DocxTextRun[];
  readonly styleId?: string;
  readonly headingLevel?: number;
  readonly list?: { readonly id: string; readonly level: number };
  readonly images: readonly DocxInlineImage[];
}

export interface DocxTableCell {
  readonly structuralPath: readonly number[];
  readonly blocks: readonly DocxFlowBlock[];
}

export interface DocxTableRow {
  readonly cells: readonly DocxTableCell[];
}

export interface DocxTableBlock {
  readonly kind: 'table';
  readonly id: string;
  readonly index: number;
  readonly structuralPath: readonly number[];
  readonly rows: readonly DocxTableRow[];
  readonly text: string;
}

export interface DocxSectionBreakBlock {
  readonly kind: 'section-break';
  readonly id: string;
  readonly index: number;
  readonly structuralPath: readonly number[];
  readonly text: '';
}

export type DocxFlowBlock = DocxParagraphBlock | DocxTableBlock | DocxSectionBreakBlock;

export interface DocxRenderModel {
  readonly kind: 'docx-flow';
  readonly blocks: readonly DocxFlowBlock[];
  readonly footnotes: ReadonlyMap<string, string>;
  readonly endnotes: ReadonlyMap<string, string>;
}
