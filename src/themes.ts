export const readingThemes = [
  'original',
  'soft-gray',
  'mint',
  'dark',
  'midnight',
  'twilight',
  'dawn',
] as const;

export type ReadingTheme = (typeof readingThemes)[number];

export interface ThemeSemanticPalette {
  mainBackground: string;
  cardBackground: string;
  drawerBackground: string;
  sectionBackground: string;
  toolbarBackground: string;
  dictionaryBackground: string;
  selectionToolbarBackground: string;
  selectionToolbarActive: string;
  noteFocusBackground: string;
  glossaryCardBackground: string;
  navigationFocusColor: string;
  secondaryAccentColor: string;
  secondaryAccentHover: string;
  secondaryAccentActive: string;
  secondarySoftFill: string;
  secondaryTextColor: string;
  faintTextColor: string;
  strongerBorderColor: string;
  dividerColor: string;
  accentHover: string;
  accentActive: string;
  accentSoftFill: string;
  accentBorderColor: string;
  chipBackground: string;
  chipSelectedBackground: string;
  chipSelectedText: string;
  informationalTint: string;
  destructiveColor: string;
}

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
  glossaryUnderlineColor: string;
  noteColor: string;
  scrollbarTrack: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  scrollbarThumbActive: string;
  scrollbarBorder: string;
  semanticPalette?: ThemeSemanticPalette;
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
    glossaryUnderlineColor: '#242321',
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
    glossaryUnderlineColor: '#25282b',
    noteColor: '#b8826c',
    scrollbarTrack: '#cdd1d5',
    scrollbarThumb: '#7b8791',
    scrollbarThumbHover: '#65727d',
    scrollbarThumbActive: '#53606a',
    scrollbarBorder: '#cdd1d5',
  },
  mint: {
    id: 'mint',
    label: 'Mint',
    appBackground: '#BDD3CC',
    surfaceBackground: '#EBF4F0',
    elevatedBackground: '#F6FAF8',
    panelBackground: '#C7DDD5',
    inputBackground: '#F5FAF8',
    textColor: '#17383A',
    mutedTextColor: '#315456',
    borderColor: '#89ACA6',
    pageBackground: '#F7FAF9',
    canvasFilter: 'none',
    accentColor: '#237563',
    highlightColor: '#C2E0D5',
    underlineColor: '#8A4D52',
    glossaryUnderlineColor: '#1C5B52',
    noteColor: '#2E806D',
    scrollbarTrack: '#ABC8C0',
    scrollbarThumb: '#648F87',
    scrollbarThumbHover: '#4C7A72',
    scrollbarThumbActive: '#37675F',
    scrollbarBorder: '#ABC8C0',
    semanticPalette: {
      mainBackground: '#DCE9E4',
      cardBackground: '#F3F8F6',
      drawerBackground: '#D0E2DC',
      sectionBackground: '#D6E6E1',
      toolbarBackground: '#C8DDD6',
      dictionaryBackground: '#F3F8F6',
      selectionToolbarBackground: '#F6FAF8',
      selectionToolbarActive: '#AED5CA',
      noteFocusBackground: '#B9DBD1',
      glossaryCardBackground: '#DCEBE6',
      navigationFocusColor: '#A8D0C4',
      secondaryAccentColor: '#2F728F',
      secondaryAccentHover: '#256681',
      secondaryAccentActive: '#1D596F',
      secondarySoftFill: '#C8E1EA',
      secondaryTextColor: '#315456',
      faintTextColor: '#315456',
      strongerBorderColor: '#648E87',
      dividerColor: '#A4C1BB',
      accentHover: '#1C6858',
      accentActive: '#145A4C',
      accentSoftFill: '#BDDCD2',
      accentBorderColor: '#57988A',
      chipBackground: '#C4E0D7',
      chipSelectedBackground: '#237563',
      chipSelectedText: '#FFFFFF',
      informationalTint: '#C9E1E7',
      destructiveColor: '#8F454B',
    },
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
    canvasFilter:
      'invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.9) saturate(0.78)',
    accentColor: '#87b9dc',
    highlightColor: '#8c7538',
    underlineColor: '#cc8977',
    glossaryUnderlineColor: '#e4e7eb',
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
    canvasFilter:
      'invert(0.92) hue-rotate(168deg) brightness(0.72) contrast(0.92) saturate(0.82)',
    accentColor: '#a79ae6',
    highlightColor: '#8a7641',
    underlineColor: '#cc8eb8',
    glossaryUnderlineColor: '#edf0f8',
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
    appBackground: '#403626',
    surfaceBackground: '#66563E',
    elevatedBackground: '#5C4E38',
    panelBackground: '#544733',
    inputBackground: '#706047',
    textColor: '#FFF3DC',
    mutedTextColor: '#F2DEB9',
    borderColor: '#907758',
    pageBackground: '#2F281D',
    canvasFilter:
      'invert(0.9) sepia(0.24) hue-rotate(346deg) saturate(0.7) brightness(0.84) contrast(0.95)',
    accentColor: '#DDB562',
    highlightColor: '#B99A4B',
    underlineColor: '#E2A47A',
    glossaryUnderlineColor: '#FFF0CC',
    noteColor: '#D18E6C',
    scrollbarTrack: '#3A3022',
    scrollbarThumb: '#A1814D',
    scrollbarThumbHover: '#BE9B5B',
    scrollbarThumbActive: '#D0AE6B',
    scrollbarBorder: '#3A3022',
    semanticPalette: {
      mainBackground: '#473C2B',
      cardBackground: '#5C4E38',
      drawerBackground: '#544733',
      sectionBackground: '#4D412F',
      toolbarBackground: '#504431',
      dictionaryBackground: '#5C4E38',
      selectionToolbarBackground: '#66563E',
      selectionToolbarActive: '#776442',
      noteFocusBackground: '#72523D',
      glossaryCardBackground: '#594B36',
      navigationFocusColor: '#6C5937',
      secondaryAccentColor: '#F1C96F',
      secondaryAccentHover: '#F6D487',
      secondaryAccentActive: '#D7AA50',
      secondarySoftFill: '#67583C',
      secondaryTextColor: '#F2DEB9',
      faintTextColor: '#F2DEB9',
      strongerBorderColor: '#AA8D65',
      dividerColor: '#78644A',
      accentHover: '#E9C374',
      accentActive: '#C89B48',
      accentSoftFill: '#6C5937',
      accentBorderColor: '#B99757',
      chipBackground: '#67563C',
      chipSelectedBackground: '#DDB562',
      chipSelectedText: '#352A19',
      informationalTint: '#5A503D',
      destructiveColor: '#F2A585',
    },
  },
  dawn: {
    id: 'dawn',
    label: 'Dawn',
    appBackground: '#493641',
    surfaceBackground: '#71515F',
    elevatedBackground: '#684A56',
    panelBackground: '#604550',
    inputBackground: '#765765',
    textColor: '#FFF4F7',
    mutedTextColor: '#F0DDE5',
    borderColor: '#947080',
    pageBackground: '#38272F',
    canvasFilter:
      'invert(0.9) sepia(0.18) hue-rotate(292deg) saturate(0.68) brightness(0.84) contrast(0.95)',
    accentColor: '#E39AAE',
    highlightColor: '#C4A062',
    underlineColor: '#F0A4B8',
    glossaryUnderlineColor: '#FFE5ED',
    noteColor: '#D48AA0',
    scrollbarTrack: '#422F38',
    scrollbarThumb: '#A66C81',
    scrollbarThumbHover: '#C17E96',
    scrollbarThumbActive: '#D58DA4',
    scrollbarBorder: '#422F38',
    semanticPalette: {
      mainBackground: '#513B46',
      cardBackground: '#684A56',
      drawerBackground: '#604550',
      sectionBackground: '#57404A',
      toolbarBackground: '#5A414B',
      dictionaryBackground: '#684A56',
      selectionToolbarBackground: '#71515F',
      selectionToolbarActive: '#795665',
      noteFocusBackground: '#76515F',
      glossaryCardBackground: '#604550',
      navigationFocusColor: '#795665',
      secondaryAccentColor: '#F0B8C5',
      secondaryAccentHover: '#FAC5D1',
      secondaryAccentActive: '#DFA0B1',
      secondarySoftFill: '#725260',
      secondaryTextColor: '#F0DDE5',
      faintTextColor: '#E8D5DE',
      strongerBorderColor: '#AF8798',
      dividerColor: '#80606F',
      accentHover: '#F0AEC0',
      accentActive: '#CF8197',
      accentSoftFill: '#795665',
      accentBorderColor: '#D690A3',
      chipBackground: '#684A56',
      chipSelectedBackground: '#E39AAE',
      chipSelectedText: '#3A252E',
      informationalTint: '#615165',
      destructiveColor: '#FFB0BB',
    },
  },
};

export function isReadingTheme(value: unknown): value is ReadingTheme {
  return typeof value === 'string' && readingThemes.includes(value as ReadingTheme);
}

export function getGlossaryUnderlineColor(themeId: string): string {
  return isReadingTheme(themeId)
    ? themes[themeId].glossaryUnderlineColor
    : themes.original.glossaryUnderlineColor;
}
