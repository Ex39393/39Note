import { useEffect, useState, type CSSProperties, type PropsWithChildren } from 'react';
import { ThemeContext } from '../theme/ThemeContext';
import { isReadingTheme, themes, type ReadingTheme, type ThemeDefinition } from '../themes';

const THEME_PREFERENCE_KEY = '39note-reading-theme';

function createThemeVariables(theme: ThemeDefinition): CSSProperties {
  const isDawn = theme.id === 'dawn';
  const semantic = theme.semanticPalette;
  return {
    '--theme-background': theme.appBackground,
    '--theme-main': semantic?.mainBackground ?? theme.appBackground,
    '--theme-surface': theme.surfaceBackground,
    '--theme-elevated': semantic?.cardBackground ?? theme.surfaceBackground,
    '--theme-card': semantic?.cardBackground ?? theme.surfaceBackground,
    '--theme-drawer': semantic?.drawerBackground ?? theme.panelBackground,
    '--theme-section': semantic?.sectionBackground ?? theme.appBackground,
    '--theme-document-surround': theme.appBackground,
    '--theme-dictionary': semantic?.dictionaryBackground ?? theme.surfaceBackground,
    '--theme-selection-toolbar': semantic?.selectionToolbarBackground ?? theme.elevatedBackground,
    '--theme-selection-active': semantic?.selectionToolbarActive
      ?? `color-mix(in srgb, ${theme.surfaceBackground} 18%, ${theme.elevatedBackground})`,
    '--theme-note-focus': semantic?.noteFocusBackground ?? theme.surfaceBackground,
    '--theme-glossary-card': semantic?.glossaryCardBackground
      ?? `color-mix(in srgb, ${theme.surfaceBackground} 92%, ${theme.accentColor})`,
    '--theme-navigation-focus': semantic?.navigationFocusColor ?? 'transparent',
    '--theme-text': theme.textColor,
    '--theme-secondary-text': semantic?.secondaryTextColor ?? theme.textColor,
    '--theme-muted-text': theme.mutedTextColor,
    '--theme-faint-text': semantic?.faintTextColor ?? theme.textColor,
    '--theme-heading': theme.textColor,
    '--theme-toolbar': semantic?.toolbarBackground ?? theme.elevatedBackground,
    '--theme-toolbar-input': semantic ? theme.inputBackground : theme.elevatedBackground,
    '--theme-sidebar': theme.panelBackground,
    '--theme-input': theme.inputBackground,
    '--theme-border': theme.borderColor,
    '--theme-strong-border': semantic?.strongerBorderColor ?? theme.borderColor,
    '--theme-divider': semantic?.dividerColor ?? theme.borderColor,
    '--theme-accent': theme.accentColor,
    '--theme-accent-contrast': semantic?.chipSelectedText ?? theme.elevatedBackground,
    '--theme-accent-hover': semantic?.accentHover ?? theme.accentColor,
    '--theme-accent-active': semantic?.accentActive ?? theme.accentColor,
    '--theme-accent-soft': semantic?.accentSoftFill
      ?? `color-mix(in srgb, ${theme.accentColor} 18%, ${theme.surfaceBackground})`,
    '--theme-accent-border': semantic?.accentBorderColor ?? theme.borderColor,
    '--theme-link': semantic?.secondaryAccentColor ?? theme.accentColor,
    '--theme-link-hover': semantic?.secondaryAccentHover ?? theme.accentColor,
    '--theme-link-active': semantic?.secondaryAccentActive ?? theme.accentColor,
    '--theme-link-soft': semantic?.secondarySoftFill
      ?? `color-mix(in srgb, ${theme.accentColor} 14%, ${theme.surfaceBackground})`,
    '--theme-info-tint': semantic?.informationalTint
      ?? `color-mix(in srgb, ${theme.accentColor} 12%, ${theme.surfaceBackground})`,
    '--theme-selection': semantic?.secondaryTextColor ?? theme.mutedTextColor,
    '--theme-highlight': theme.highlightColor,
    '--theme-underline': theme.underlineColor,
    '--glossary-underline-color': theme.glossaryUnderlineColor,
    '--theme-note': theme.noteColor,
    '--theme-bold': theme.textColor,
    '--theme-page-background': theme.pageBackground,
    '--theme-canvas-filter': theme.canvasFilter,
    '--library-scope-bg': semantic?.chipBackground ?? theme.surfaceBackground,
    '--library-scope-text': theme.textColor,
    '--library-scope-hover-bg': semantic?.accentSoftFill
      ?? `color-mix(in srgb, ${theme.accentColor} 18%, ${theme.surfaceBackground})`,
    '--library-scope-active-bg': semantic?.chipSelectedBackground ?? theme.accentColor,
    '--library-scope-active-text': semantic?.chipSelectedText ?? theme.elevatedBackground,
    '--library-scope-active-border': semantic?.accentBorderColor ?? theme.accentColor,
    '--metadata-chip-bg': semantic?.chipBackground
      ?? (isDawn ? '#6c3f50' : theme.elevatedBackground),
    '--metadata-chip-text': isDawn ? '#f6edf2' : theme.textColor,
    '--metadata-chip-border': semantic?.accentBorderColor
      ?? (isDawn ? '#9b6678' : theme.borderColor),
    '--metadata-chip-hover-bg': semantic?.secondarySoftFill
      ?? (isDawn ? '#7b495c' : `color-mix(in srgb, ${theme.accentColor} 14%, ${theme.elevatedBackground})`),
    '--metadata-chip-remove-icon': isDawn ? '#f7e9ef' : theme.mutedTextColor,
    '--metadata-chip-remove-hover': isDawn ? '#ffffff' : theme.textColor,
    '--pin-accent': theme.noteColor,
    '--control-bg': semantic?.cardBackground ?? theme.surfaceBackground,
    '--control-border': semantic?.strongerBorderColor ?? theme.borderColor,
    '--control-text': theme.textColor,
    '--control-hover-bg': semantic?.accentSoftFill
      ?? `color-mix(in srgb, ${theme.accentColor} 14%, ${theme.surfaceBackground})`,
    '--control-hover-border': semantic?.accentBorderColor
      ?? `color-mix(in srgb, ${theme.accentColor} 55%, ${theme.borderColor})`,
    '--control-hover-brightness': theme.id === 'original' || theme.id === 'soft-gray' ? '1.04' : '1.07',
    '--control-active-bg': semantic?.selectionToolbarActive
      ?? `color-mix(in srgb, ${theme.accentColor} 24%, ${theme.surfaceBackground})`,
    '--control-disabled-bg': `color-mix(in srgb, ${theme.mutedTextColor} 8%, ${theme.surfaceBackground})`,
    '--control-disabled-text': theme.mutedTextColor,
    '--control-height-compact': '32px',
    '--control-height-standard': '38px',
    '--control-radius': '7px',
    '--pill-radius': '999px',
    '--panel-radius': '12px',
    '--gap-compact': '7px',
    '--gap-standard': '11px',
    '--gap-section': '18px',
    '--font-control': '0.74rem',
    '--focus-ring': semantic?.secondaryAccentColor
      ?? `color-mix(in srgb, ${theme.accentColor} 72%, transparent)`,
    '--panel-elevation': `0 12px 30px color-mix(in srgb, ${theme.textColor} 15%, transparent)`,
    '--destructive-text': semantic?.destructiveColor ?? theme.underlineColor,
    '--destructive-bg': `color-mix(in srgb, ${semantic?.destructiveColor ?? theme.underlineColor} 10%, ${theme.surfaceBackground})`,
    '--scrollbar-track': theme.scrollbarTrack,
    '--scrollbar-thumb': theme.scrollbarThumb,
    '--scrollbar-thumb-hover': theme.scrollbarThumbHover,
    '--scrollbar-thumb-active': theme.scrollbarThumbActive,
    '--scrollbar-border': theme.scrollbarBorder,
  } as CSSProperties;
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [themeId, setThemeId] = useState<ReadingTheme>(() => {
    try {
      const storedTheme = window.localStorage.getItem(THEME_PREFERENCE_KEY);
      return isReadingTheme(storedTheme) ? storedTheme : 'original';
    } catch {
      return 'original';
    }
  });
  const theme = themes[themeId];

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_PREFERENCE_KEY, themeId);
    } catch {
      // Theme persistence is optional when browser storage is unavailable.
    }
  }, [themeId]);

  return (
    <ThemeContext.Provider value={{ theme, themeId, setTheme: setThemeId }}>
      <div className="theme-root" data-reading-theme={themeId} style={createThemeVariables(theme)}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
