import { DEFAULT_SEARCH_ENGINE } from '../../../src/browser/url';
import type { Settings } from '../shared/types';
import { jsonFile } from './store';

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: DEFAULT_SEARCH_ENGINE,
  customSearchTemplate: '',
  theme: 'system',
  shields: {
    enabled: true,
    httpsUpgrade: true,
    blockPopups: true,
    cosmeticFiltering: true,
    blockThirdPartyCookies: true,
    hideCookieBanners: true,
  },
  disabledSites: [],
  disabledLists: [],
  searchSuggestions: true,
  restoreTabs: true,
  clearDataOnExit: false,
};

type Listener = (settings: Settings, previous: Settings) => void;

let file: ReturnType<typeof jsonFile<Partial<Settings>>> | null = null;
let current: Settings = DEFAULT_SETTINGS;
const listeners = new Set<Listener>();

/** Reads the saved settings; fields added in later versions get their defaults. */
export function loadSettings(): Settings {
  file = jsonFile<Partial<Settings>>('settings.json', {});
  const saved = file.value;
  current = { ...DEFAULT_SETTINGS, ...saved, shields: { ...DEFAULT_SETTINGS.shields, ...saved.shields } };
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  const previous = current;
  current = { ...current, ...patch, shields: { ...current.shields, ...patch.shields } };
  if (file) {
    file.value = current;
    file.changed();
  }
  for (const listener of listeners) listener(current, previous);
}

export function onSettingsChanged(listener: Listener): void {
  listeners.add(listener);
}
