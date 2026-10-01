import type { OoxmlImageResource } from '../ooxml/package';

export interface PptxSize {
  readonly widthEmu: number;
  readonly heightEmu: number;
}

export interface PptxBounds {
  readonly xEmu: number;
  readonly yEmu: number;
  readonly widthEmu: number;
  readonly heightEmu: number;
}

export interface PptxTextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly fontFamily?: string;
  readonly fontSizePoints?: number;
  readonly color?: string;
}

export interface PptxTextRun {
  readonly index: number;
  readonly text: string;
  readonly style: PptxTextStyle;
  readonly hyperlink?: string;
}

export interface PptxParagraph {
  readonly index: number;
  readonly text: string;
  readonly alignment?: 'left' | 'center' | 'right' | 'justify';
  readonly runs: readonly PptxTextRun[];
}

export interface PptxShapeStyle {
  readonly fill?: string;
  readonly borderColor?: string;
  readonly borderWidthPoints?: number;
}

export interface PptxShape {
  readonly id: string;
  readonly name: string;
  readonly kind: 'text' | 'shape' | 'image' | 'group' | 'unsupported';
  readonly order: number;
  readonly bounds: PptxBounds;
  readonly rotationDegrees?: number;
  readonly style: PptxShapeStyle;
  readonly paragraphs: readonly PptxParagraph[];
  readonly image?: OoxmlImageResource;
  readonly children?: readonly PptxShape[];
}

export interface PptxSlide {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly partName: string;
  readonly size: PptxSize;
  readonly shapes: readonly PptxShape[];
  readonly speakerNotes: string;
  readonly extractedText: string;
}

export interface PptxSlideDescriptor {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly partName: string;
  readonly size: PptxSize;
  readonly isLoaded: () => boolean;
  readonly peek: () => PptxSlide | null;
  readonly load: () => Promise<PptxSlide>;
}

export interface PptxRenderModel {
  readonly kind: 'pptx-slides';
  readonly size: PptxSize;
  readonly slides: readonly PptxSlideDescriptor[];
}
