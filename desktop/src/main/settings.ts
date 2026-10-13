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
  popupSites: [],
  wallpaper: 'photos',
  version: 2,
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
  current = { ...DEFAULT_SETTINGS, ...saved, shields: { ...DEFAULT_SETTINGS.shields, ...saved.shields }, version: DEFAULT_SETTINGS.version };
  // A hand-edited or damaged file: anything of the wrong kind goes back to its default.
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const loaded = current as unknown as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const wanted = defaults[key];
    const kind = (value: unknown) => (Array.isArray(value) ? 'list' : typeof value);
    if (kind(loaded[key]) !== kind(wanted)) loaded[key] = wanted;
    else if (Array.isArray(wanted)) loaded[key] = (loaded[key] as unknown[]).filter((item) => typeof item === 'string');
  }
  for (const key of Object.keys(DEFAULT_SETTINGS.shields) as (keyof Settings['shields'])[]) {
    if (typeof current.shields[key] !== 'boolean') current.shields[key] = DEFAULT_SETTINGS.shields[key];
  }
  // Version 2 brought photos; until then 'brand' was simply the default, not a choice.
  if ((saved.version ?? 1) < 2 && saved.wallpaper === 'brand') current.wallpaper = 'photos';
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
