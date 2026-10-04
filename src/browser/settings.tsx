import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { ShieldEngine } from '../../native/shield-webview';
import catalog from '../blocking/filter-catalog.json';
import type { AccentId } from '../ui/theme';
import type { Profile } from './profiles';
import { DEFAULT_SEARCH_ENGINE, type SearchEngineId } from './url';

export type ShieldSettings = {
  enabled: boolean;
  httpsUpgrade: boolean;
  blockPopups: boolean;
  cosmeticFiltering: boolean;
  blockThirdPartyCookies: boolean;
  /** Includes the EasyList Cookie List (Android rebuilds the engine without it when off). */
  hideCookieBanners: boolean;
  /** Keep audio and video playing when the app is in the background or the screen is off. */
  backgroundPlay: boolean;
  /** Stillweb Plus: reject cookie pop-ups and hide annoyances (only applied while Plus is active). */
  calmMode: boolean;
};

/** Changes for one site: desktop website (free), JavaScript off and hidden elements (Plus). */
export type SiteFix = { desktop?: boolean; noScript?: boolean; hidden?: string[] };

export type Settings = {
  searchEngine: SearchEngineId;
  customSearchTemplate: string;
  theme: 'system' | 'light' | 'dark';
  /** Stillweb Plus: accent color (blue without Plus). */
  accent: AccentId;
  /** Darken pages without their own dark theme while the app is dark. */
  darkPages: boolean;
  textZoom: number;
  shields: ShieldSettings;
  /** Sites (host, without www.) where shields are off. */
  disabledSites: string[];
  /** Per-site fixes, by site (host without www.). */
  siteFixes: Record<string, SiteFix>;
  clearDataOnExit: boolean;
  lockPrivateTabs: boolean;
  /** Bottom keeps the address bar in thumb reach, like Safari. */
  addressBarPosition: 'top' | 'bottom';
  /** Stillweb Plus: bookmarks and (iOS) downloads from private tabs go to the locked vault. */
  vault: boolean;
  /** Ask the search engine for suggestions while typing (never in private tabs). */
  searchSuggestions: boolean;
  /** Stillweb Plus: profiles besides the default one, each with its own cookies and site data. */
  profiles: Profile[];
};

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: DEFAULT_SEARCH_ENGINE,
  customSearchTemplate: '',
  theme: 'system',
  accent: 'blue',
  darkPages: true,
  textZoom: 100,
  shields: {
    enabled: true,
    httpsUpgrade: true,
    blockPopups: true,
    cosmeticFiltering: true,
    blockThirdPartyCookies: true,
    hideCookieBanners: true,
    backgroundPlay: true,
    calmMode: false,
  },
  disabledSites: [],
  siteFixes: {},
  clearDataOnExit: false,
  lockPrivateTabs: false,
  addressBarPosition: Platform.OS === 'ios' ? 'bottom' : 'top',
  searchSuggestions: true,
  vault: true,
  profiles: [],
};

const STORAGE_KEY = 'settings.v1';
const COOKIE_LIST_ID = 'easylist-cookie';

type SettingsContextValue = {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Omit<Settings, 'shields'>> & { shields?: Partial<ShieldSettings> }) => void;
  setSiteShields: (site: string, enabled: boolean) => void;
  /** Merges a change into a site's fixes; null removes them all. */
  setSiteFix: (site: string, patch: Partial<SiteFix> | null) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

function pushToNative(next: Settings, prev: Settings | null) {
  // Calm Mode depends on Plus too; App sends it (see PlusFeatureSync).
  const { hideCookieBanners, calmMode: _calmMode, ...options } = next.shields;
  ShieldEngine.setOptions(options);
  ShieldEngine.setDisabledSites(next.disabledSites);
  if (Platform.OS === 'android' && (!prev || prev.shields.hideCookieBanners !== hideCookieBanners)) {
    const ids = hideCookieBanners ? null : catalog.lists.map((l) => l.id).filter((id) => id !== COOKIE_LIST_ID);
    ShieldEngine.setEnabledLists(ids).catch(() => {});
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const pushed = useRef<Settings | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw) as Partial<Settings>;
        setSettings({
          ...DEFAULT_SETTINGS,
          ...saved,
          shields: { ...DEFAULT_SETTINGS.shields, ...saved.shields },
        });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    // First run after loading (later changes were already pushed by apply()).
    if (pushed.current !== settings) {
      pushToNative(settings, pushed.current);
      pushed.current = settings;
    }
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings)).catch(() => {});
  }, [settings, loaded]);

  // Native shield state is pushed synchronously so a reload right after a change sees it.
  const current = useRef(settings);
  current.current = settings;
  const apply = useCallback((next: Settings) => {
    pushToNative(next, pushed.current);
    pushed.current = next;
    current.current = next;
    setSettings(next);
  }, []);

  const update = useCallback<SettingsContextValue['update']>(
    (patch) => {
      const s = current.current;
      apply({ ...s, ...patch, shields: { ...s.shields, ...patch.shields } });
    },
    [apply],
  );

  const setSiteShields = useCallback(
    (site: string, enabled: boolean) => {
      const s = current.current;
      const others = s.disabledSites.filter((h) => h !== site);
      apply({ ...s, disabledSites: enabled ? others : [...others, site] });
    },
    [apply],
  );

  const setSiteFix = useCallback(
    (site: string, patch: Partial<SiteFix> | null) => {
      const s = current.current;
      const fixes = { ...s.siteFixes };
      const next: SiteFix = patch ? { ...fixes[site], ...patch } : {};
      if (next.desktop || next.noScript || next.hidden?.length) fixes[site] = next;
      else delete fixes[site];
      apply({ ...s, siteFixes: fixes });
    },
    [apply],
  );

  const value = useMemo(
    () => ({ settings, loaded, update, setSiteShields, setSiteFix }),
    [settings, loaded, update, setSiteShields, setSiteFix],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
