export interface NormalizedHighlightRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationType = 'highlight' | 'underline';

export const highlightColors = {
  yellow: { label: 'Yellow', cssValue: 'rgb(255 230 0 / 35%)' },
  green: { label: 'Green', cssValue: 'rgb(90 210 120 / 32%)' },
  blue: { label: 'Blue', cssValue: 'rgb(70 150 255 / 30%)' },
  pink: { label: 'Pink', cssValue: 'rgb(255 105 180 / 30%)' },
} as const;

export type HighlightColor = keyof typeof highlightColors;

export const underlineColors = {
  red: { label: 'Red', cssValue: '#ff3b30' },
  green: { label: 'Green', cssValue: '#20c75a' },
  blue: { label: 'Blue', cssValue: '#1687ff' },
  black: { label: 'Black', cssValue: '#111111' },
} as const;

export type UnderlineColor = keyof typeof underlineColors;

interface BaseAnnotation<TType extends AnnotationType, TColor extends string> {
  id: string;
  type: TType;
  pageNumber: number;
  text: string;
  rects: NormalizedHighlightRectangle[];
  color: TColor;
  createdAt: number;
  updatedAt: number;
}

export type HighlightAnnotation = BaseAnnotation<'highlight', HighlightColor>;
export type UnderlineAnnotation = BaseAnnotation<'underline', UnderlineColor>;
export type PdfAnnotation = HighlightAnnotation | UnderlineAnnotation;
