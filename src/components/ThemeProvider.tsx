import { useEffect, useState, type CSSProperties, type PropsWithChildren } from 'react';
import { ThemeContext } from '../theme/ThemeContext';
import { isReadingTheme, themes, type ReadingTheme, type ThemeDefinition } from '../themes';

const THEME_PREFERENCE_KEY = '39note-reading-theme';

function createThemeVariables(theme: ThemeDefinition): CSSProperties {
  const isDawn = theme.id === 'dawn';
  return {
    '--theme-background': theme.appBackground,
    '--theme-surface': theme.surfaceBackground,
    '--theme-text': theme.textColor,
    '--theme-heading': theme.textColor,
    '--theme-toolbar': theme.elevatedBackground,
    '--theme-sidebar': theme.panelBackground,
    '--theme-input': theme.inputBackground,
    '--theme-border': theme.borderColor,
    '--theme-accent': theme.accentColor,
    '--theme-selection': theme.mutedTextColor,
    '--theme-highlight': theme.highlightColor,
    '--theme-underline': theme.underlineColor,
    '--glossary-underline-color': theme.glossaryUnderlineColor,
    '--theme-note': theme.noteColor,
    '--theme-bold': theme.textColor,
    '--theme-page-background': theme.pageBackground,
    '--theme-canvas-filter': theme.canvasFilter,
    '--library-scope-bg': theme.surfaceBackground,
    '--library-scope-text': theme.textColor,
    '--library-scope-hover-bg': `color-mix(in srgb, ${theme.accentColor} 18%, ${theme.surfaceBackground})`,
    '--library-scope-active-bg': theme.accentColor,
    '--library-scope-active-text': theme.elevatedBackground,
    '--library-scope-active-border': theme.accentColor,
    '--metadata-chip-bg': isDawn ? '#6c3f50' : theme.elevatedBackground,
    '--metadata-chip-text': isDawn ? '#f6edf2' : theme.textColor,
    '--metadata-chip-border': isDawn ? '#9b6678' : theme.borderColor,
    '--metadata-chip-hover-bg': isDawn ? '#7b495c' : `color-mix(in srgb, ${theme.accentColor} 14%, ${theme.elevatedBackground})`,
    '--metadata-chip-remove-icon': isDawn ? '#f7e9ef' : theme.mutedTextColor,
    '--metadata-chip-remove-hover': isDawn ? '#ffffff' : theme.textColor,
    '--pin-accent': theme.noteColor,
    '--control-bg': theme.surfaceBackground,
    '--control-border': theme.borderColor,
    '--control-text': theme.textColor,
    '--control-hover-bg': `color-mix(in srgb, ${theme.accentColor} 14%, ${theme.surfaceBackground})`,
    '--control-hover-border': `color-mix(in srgb, ${theme.accentColor} 55%, ${theme.borderColor})`,
    '--control-hover-brightness': theme.id === 'original' || theme.id === 'soft-gray' ? '1.04' : '1.07',
    '--control-active-bg': `color-mix(in srgb, ${theme.accentColor} 24%, ${theme.surfaceBackground})`,
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
    '--focus-ring': `color-mix(in srgb, ${theme.accentColor} 72%, transparent)`,
    '--panel-elevation': `0 12px 30px color-mix(in srgb, ${theme.textColor} 15%, transparent)`,
    '--destructive-text': theme.underlineColor,
    '--destructive-bg': `color-mix(in srgb, ${theme.underlineColor} 10%, ${theme.surfaceBackground})`,
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
