import { useSyncExternalStore } from 'react';
import { Appearance, AppState, type ColorSchemeName } from 'react-native';

export type Theme = {
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentSoft: string;
  /** Data marks (privacy report bars); validated for contrast on this mode's background. */
  chart: string;
  danger: string;
  privateBackground: string;
  privateSurface: string;
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
  chart: '#2F6FEB',
  danger: '#D93D3D',
  privateBackground: '#1E1630',
  privateSurface: '#2C2244',
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
  chart: '#5E8FF0',
  danger: '#F06A6A',
  privateBackground: '#1A1328',
  privateSurface: '#2A2140',
};

type AccentColors = Pick<Theme, 'accent' | 'accentSoft' | 'chart'>;

/**
 * Accent colors (Stillweb Plus; blue is the default). Each chart color passes the data-viz
 * palette checks on its mode's background; graphite is gray by design, so its charts stay blue.
 */
export const ACCENTS = {
  blue: { label: 'Blue', light: { accent: '#2F6FEB', accentSoft: '#E3ECFD', chart: '#2F6FEB' }, dark: { accent: '#6E9BF5', accentSoft: '#1F2B45', chart: '#5E8FF0' } },
  teal: { label: 'Teal', light: { accent: '#0A7EA4', accentSoft: '#DFEEF3', chart: '#0A7EA4' }, dark: { accent: '#2BA3AD', accentSoft: '#173034', chart: '#2BA3AD' } },
  green: { label: 'Green', light: { accent: '#1F7A3E', accentSoft: '#E2EEE6', chart: '#1F7A3E' }, dark: { accent: '#3E9E5F', accentSoft: '#1B2F25', chart: '#3E9E5F' } },
  orange: { label: 'Orange', light: { accent: '#C2410C', accentSoft: '#F7E6DF', chart: '#C2410C' }, dark: { accent: '#E06A2E', accentSoft: '#3B241B', chart: '#E06A2E' } },
  pink: { label: 'Pink', light: { accent: '#BE185D', accentSoft: '#F7E1EA', chart: '#BE185D' }, dark: { accent: '#E0518A', accentSoft: '#3B1F2D', chart: '#E0518A' } },
  purple: { label: 'Purple', light: { accent: '#6D3FD1', accentSoft: '#ECE6F9', chart: '#6D3FD1' }, dark: { accent: '#9273E6', accentSoft: '#2C2640', chart: '#9273E6' } },
  graphite: { label: 'Graphite', light: { accent: '#4B5563', accentSoft: '#E8E9EB', chart: '#2F6FEB' }, dark: { accent: '#8A94A3', accentSoft: '#2A2D32', chart: '#5E8FF0' } },
} satisfies Record<string, { label: string; light: AccentColors; dark: AccentColors }>;

export type AccentId = keyof typeof ACCENTS;

const themes = new Map<string, Theme>();

// The system appearance as last seen while the app was in use. On its way to the background
// iOS reports the other appearance and back (it photographs the app in both for the app
// switcher); following that would restyle the whole app, and every open page, twice.
let systemScheme: ColorSchemeName | null | undefined = Appearance.getColorScheme();
const schemeListeners = new Set<() => void>();
const notifySchemeListeners = () => schemeListeners.forEach((listener) => listener());
Appearance.addChangeListener(notifySchemeListeners);
AppState.addEventListener('change', notifySchemeListeners);
function subscribeToScheme(listener: () => void) {
  schemeListeners.add(listener);
  return () => {
    schemeListeners.delete(listener);
  };
}
function getSystemScheme() {
  if (AppState.currentState === 'active') systemScheme = Appearance.getColorScheme();
  return systemScheme;
}

/** Follows the system appearance unless a preference overrides it, in the chosen accent. */
export function useTheme(override?: 'system' | 'light' | 'dark', accent: AccentId = 'blue'): Theme {
  const system = useSyncExternalStore(subscribeToScheme, getSystemScheme);
  const mode = override && override !== 'system' ? override : system;
  const isDark = mode === 'dark';
  // One object per mode and accent, so screens don't re-render for a "new" theme.
  const key = `${isDark ? 'dark' : 'light'}-${accent}`;
  let theme = themes.get(key);
  if (!theme) {
    const colors = (ACCENTS[accent] ?? ACCENTS.blue)[isDark ? 'dark' : 'light'];
    theme = { ...(isDark ? dark : light), ...colors };
    themes.set(key, theme);
  }
  return theme;
}
