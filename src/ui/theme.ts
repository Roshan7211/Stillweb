import { useColorScheme } from 'react-native';

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

/** Follows the system appearance unless a preference overrides it. */
export function useTheme(override?: 'system' | 'light' | 'dark'): Theme {
  const system = useColorScheme();
  const mode = override && override !== 'system' ? override : system;
  return mode === 'dark' ? dark : light;
}
