export const readingThemes = ['original', 'soft-gray', 'dark', 'midnight', 'twilight', 'dawn'] as const;

export type ReadingTheme = (typeof readingThemes)[number];

export interface ThemeDefinition {
  id: ReadingTheme;
  label: string;
  appBackground: string;
  surfaceBackground: string;
  elevatedBackground: string;
  panelBackground: string;
  inputBackground: string;
  textColor: string;
  mutedTextColor: string;
  borderColor: string;
  pageBackground: string;
  canvasFilter: string;
  accentColor: string;
  highlightColor: string;
  underlineColor: string;
  noteColor: string;
  scrollbarTrack: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  scrollbarThumbActive: string;
  scrollbarBorder: string;
}

export const themes: Record<ReadingTheme, ThemeDefinition> = {
  original: {
    id: 'original',
    label: 'Original',
    appBackground: '#ebe6db',
    surfaceBackground: '#fffdf8',
    elevatedBackground: '#f4efe5',
    panelBackground: '#f4efe5',
    inputBackground: '#ebe6db',
    textColor: '#514b42',
    mutedTextColor: '#56616d',
    borderColor: '#a8b0b8',
    pageBackground: '#fffdf8',
    canvasFilter: 'none',
    accentColor: '#5f7d91',
    highlightColor: '#f2d985',
    underlineColor: '#b96e53',
    noteColor: '#d69b78',
    scrollbarTrack: '#e4ded2',
    scrollbarThumb: '#8f969d',
    scrollbarThumbHover: '#747d85',
    scrollbarThumbActive: '#606a72',
    scrollbarBorder: '#e4ded2',
  },
  'soft-gray': {
    id: 'soft-gray',
    label: 'Soft Gray',
    appBackground: '#d7dade',
    surfaceBackground: '#e9ebed',
    elevatedBackground: '#dfe2e5',
    panelBackground: '#dfe2e5',
    inputBackground: '#d7dade',
    textColor: '#34373b',
    mutedTextColor: '#515e68',
    borderColor: '#929da6',
    pageBackground: '#e7e8e8',
    canvasFilter: 'brightness(0.9) contrast(0.95) saturate(0.8)',
    accentColor: '#496f8a',
    highlightColor: '#d8c46f',
    underlineColor: '#b87560',
    noteColor: '#b8826c',
    scrollbarTrack: '#cdd1d5',
    scrollbarThumb: '#7b8791',
    scrollbarThumbHover: '#65727d',
    scrollbarThumbActive: '#53606a',
    scrollbarBorder: '#cdd1d5',
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    appBackground: '#171a1f',
    surfaceBackground: '#252a31',
    elevatedBackground: '#1d2228',
    panelBackground: '#1d2228',
    inputBackground: '#171a1f',
    textColor: '#d8dde3',
    mutedTextColor: '#9fb6c5',
    borderColor: '#3a414a',
    pageBackground: '#20242a',
    canvasFilter: 'invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.9) saturate(0.78)',
    accentColor: '#87b9dc',
    highlightColor: '#8c7538',
    underlineColor: '#cc8977',
    noteColor: '#bd8069',
    scrollbarTrack: '#171b20',
    scrollbarThumb: '#596572',
    scrollbarThumbHover: '#71808e',
    scrollbarThumbActive: '#8494a2',
    scrollbarBorder: '#171b20',
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    appBackground: '#121827',
    surfaceBackground: '#202a3e',
    elevatedBackground: '#182238',
    panelBackground: '#182238',
    inputBackground: '#121827',
    textColor: '#e2e8f5',
    mutedTextColor: '#b8c4df',
    borderColor: '#354361',
    pageBackground: '#1b2840',
    canvasFilter: 'invert(0.92) hue-rotate(168deg) brightness(0.72) contrast(0.92) saturate(0.82)',
    accentColor: '#a79ae6',
    highlightColor: '#8a7641',
    underlineColor: '#cc8eb8',
    noteColor: '#bc84aa',
    scrollbarTrack: '#11182a',
    scrollbarThumb: '#59688f',
    scrollbarThumbHover: '#7282aa',
    scrollbarThumbActive: '#8797bd',
    scrollbarBorder: '#11182a',
  },
  twilight: {
    id: 'twilight',
    label: 'Twilight',
    appBackground: '#2d271d',
    surfaceBackground: '#4a402c',
    elevatedBackground: '#3a3224',
    panelBackground: '#403727',
    inputBackground: '#554832',
    textColor: '#f2e9d8',
    mutedTextColor: '#dbcaa7',
    borderColor: '#715d4b',
    pageBackground: '#211c14',
    canvasFilter: 'invert(0.88) sepia(0.28) hue-rotate(346deg) saturate(0.72) brightness(0.78) contrast(0.95)',
    accentColor: '#c49a4d',
    highlightColor: '#a8883c',
    underlineColor: '#d19a70',
    noteColor: '#bf8467',
    scrollbarTrack: '#2b241a',
    scrollbarThumb: '#92713d',
    scrollbarThumbHover: '#ad8849',
    scrollbarThumbActive: '#c09a58',
    scrollbarBorder: '#2b241a',
  },
  dawn: {
    id: 'dawn',
    label: 'Dawn',
    appBackground: '#2c2228',
    surfaceBackground: '#503942',
    elevatedBackground: '#3b2a32',
    panelBackground: '#433038',
    inputBackground: '#5b414b',
    textColor: '#eee7ee',
    mutedTextColor: '#cbb9c7',
    borderColor: '#5a4054',
    pageBackground: '#21171c',
    canvasFilter: 'invert(0.88) sepia(0.22) hue-rotate(292deg) saturate(0.76) brightness(0.78) contrast(0.96)',
    accentColor: '#c98294',
    highlightColor: '#96754b',
    underlineColor: '#d18a9d',
    noteColor: '#b57489',
    scrollbarTrack: '#291c22',
    scrollbarThumb: '#875366',
    scrollbarThumbHover: '#a5647b',
    scrollbarThumbActive: '#b9788f',
    scrollbarBorder: '#291c22',
  },
};

export function isReadingTheme(value: unknown): value is ReadingTheme {
  return typeof value === 'string' && readingThemes.includes(value as ReadingTheme);
}
