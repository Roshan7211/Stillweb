// The same colors as the mobile app (src/ui/theme.ts), which cannot be imported here because
// that file depends on React Native.
export type Theme = {
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentSoft: string;
  danger: string;
};

const light: Theme = {
  dark: false,
  background: '#FFFFFF',
  surface: '#F2F3F5',
  text: '#16171A',
  muted: '#6B6F76',
  border: '#D9DCE1',
  accent: '#2F6FEB',
  accentSoft: '#E3ECFD',
  danger: '#D93D3D',
};

const dark: Theme = {
  dark: true,
  background: '#121316',
  surface: '#1E2024',
  text: '#ECEDEF',
  muted: '#9A9EA6',
  border: '#33363C',
  accent: '#6E9BF5',
  accentSoft: '#1F2B45',
  danger: '#F06A6A',
};

/** Private windows are always dark, in purple, so they cannot be mistaken for normal ones. */
const privateTheme: Theme = { ...dark, background: '#1A1328', surface: '#2A2140', border: '#40345E', accentSoft: '#3A2D5C' };

export function themeFor(isDark: boolean, isPrivate: boolean): Theme {
  return isPrivate ? privateTheme : isDark ? dark : light;
}
