import { createContext, useContext } from 'react';
import { themes, type ReadingTheme, type ThemeDefinition } from '../themes';

export interface ThemeContextValue {
  theme: ThemeDefinition;
  themeId: ReadingTheme;
  setTheme: (theme: ReadingTheme) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: themes.original,
  themeId: 'original',
  setTheme: () => undefined,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
