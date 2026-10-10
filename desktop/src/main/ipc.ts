// What the window's interface may ask for (see ChromeApi in shared/types.ts). Only the
// interface's own web contents are answered; pages have no access to any of this.
import { app, ipcMain, session as electronSession, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import catalog from '../../../src/blocking/filter-catalog.json';
import { hasRemoteSuggestions, parseSuggestions, suggestionUrl } from '../../../src/browser/suggestEndpoints';
import { CHROME_METHODS, type ChromeApi, type LicenseData, type Suggestion } from '../shared/types';
import { BrowserWin, normalSession } from './browserWindow';
import {
  clearHistory,
  getBookmarks,
  localSuggestions,
  privacyReport,
  queryHistory,
  removeHistory,
  resetPrivacyReport,
  setBookmarked,
  topSites,
} from './data';
import { cancelDownload, clearDownloads, getDownloads, openDownload, showDownload } from './downloads';
import { FIXES_LIST_ID, shieldEngine } from './engine/shieldEngine';
import { clearFavicons, iconFor, wantIcon } from './favicons';
import { clearMediaSites } from './mediaSites';
import { showAppMenu, showTabMenu } from './menus';
import { getSettings, updateSettings } from './settings';
import { pageInfo } from './shields';
import { clearThumbnails, thumbnailFor } from './thumbnails';
import { checkForFilterUpdate } from './updater';
import { chooseWallpaper, photoWallpapers, shuffledPhoto, wallpaperImage } from './wallpaper';

const COOKIE_LIST_ID = 'easylist-cookie';
/** Public privacy policy (site/privacy/, published by the Filters workflow). Optional. */
const PRIVACY_POLICY_URL = process.env.STILLWEB_PRIVACY_POLICY_URL || null;

const suggestionCache = new Map<string, Suggestion[]>();

/** Search engine suggestions, asked for without cookies so they are not tied to a person. */
async function remoteSuggestions(query: string): Promise<Suggestion[]> {
  const settings = getSettings();
  const url = suggestionUrl(settings.searchEngine, query);
  if (!url) return [];
  const key = `${settings.searchEngine}:${query.toLowerCase()}`;
  const cached = suggestionCache.get(key);
  if (cached) return cached;
  try {
    const response = await electronSession.fromPartition('suggest').fetch(url, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    const items = response.ok ? parseSuggestions(await response.json()) : [];
    suggestionCache.set(key, items);
    if (suggestionCache.size > 60) suggestionCache.delete(suggestionCache.keys().next().value as string);
    return items;
  } catch {
    return [];
  }
}

type Handlers = { [K in keyof ChromeApi]: (win: BrowserWin, ...args: Parameters<ChromeApi[K]>) => ReturnType<ChromeApi[K]> | Awaited<ReturnType<ChromeApi[K]>> };

const handlers: Handlers = {
  interfaceReady: (win) => win.interfaceReady(),
  getWindowState: (win) => win.state(),
  getSettings: () => getSettings(),
  setSettings: (_win, patch) => updateSettings(patch),
  getEngineStatus: () => shieldEngine.status(),

  setLayout: (win, layout) => win.setLayout(Number(layout.barHeight) || 0, !!layout.expanded),
  dragWindow: (win, active) => win.dragWindow(!!active),
  toggleMaximize: (win) => (win.window.isMaximized() ? win.window.unmaximize() : win.window.maximize()),

  newTab: (win, url) => void win.createTab({ url: typeof url === 'string' && /^https?:/i.test(url) ? url : undefined }),
  closeTab: (win, id) => win.closeTab(id),
  activateTab: (win, id) => win.activate(id),
  moveTab: (win, id, toIndex) => win.moveTab(id, toIndex),
  toggleMute: (win, id) => win.toggleMute(id),
  navigate: (win, input) => win.navigate(String(input)),
  goBack: (win) => win.goBack(),
  goForward: (win) => win.goForward(),
  reload: (win) => win.reload(),
  stop: (win) => win.stop(),
  focusPage: (win) => win.activeTab?.contents.focus(),

  setSiteShields: (_win, site, enabled) => {
    const host = String(site).toLowerCase();
    if (!host) return;
    const without = getSettings().disabledSites.filter((s) => s !== host);
    updateSettings({ disabledSites: enabled ? without : [...without, host] });
  },

  setSitePopups: (_win, site, allowed) => {
    const host = String(site).toLowerCase();
    if (!host) return;
    const without = getSettings().popupSites.filter((s) => s !== host);
    updateSettings({ popupSites: allowed ? [...without, host] : without });
  },
  openBlockedPopup: (win) => {
    const tab = win.activeTab;
    const last = tab ? pageInfo(tab.contents).popups.last : '';
    if (tab && /^https?:/i.test(last)) win.createTab({ url: last, afterId: tab.id });
  },

  suggestLocal: (_win, query) => localSuggestions(String(query).trim(), 5),
  suggestRemote: (win, query) => {
    const text = String(query).trim();
    const settings = getSettings();
    if (!text || !settings.searchSuggestions || win.isPrivate || !hasRemoteSuggestions(settings.searchEngine)) return [];
    return remoteSuggestions(text);
  },

  findInPage: (win, text, forward, next) => {
    if (text) win.activeTab?.contents.findInPage(String(text), { forward: !!forward, findNext: !!next });
    else win.activeTab?.contents.stopFindInPage('clearSelection');
  },
  stopFind: (win) => win.activeTab?.contents.stopFindInPage('clearSelection'),

  showAppMenu: (win, x, y) => showAppMenu(win, x, y),
  showTabMenu: (win, id, x, y) => showTabMenu(win, id, x, y),

  getBookmarks: () => getBookmarks(),
  setBookmarked: (_win, url, title, bookmarked) => setBookmarked(String(url), String(title), !!bookmarked),
  getHistory: (_win, query) => queryHistory(String(query ?? '')),
  removeHistory: (_win, url, time) => removeHistory(url, time),
  clearBrowsingData: async () => {
    clearHistory();
    clearMediaSites();
    clearFavicons();
    clearThumbnails();
    await normalSession().clearData();
  },
  getHomeTiles: (win) => {
    if (win.isPrivate) return { bookmarks: [], visited: [] };
    const tile = (entry: { url: string; title: string }) => {
      // An icon that was never seen is asked for now; the page is told when it arrives.
      const icon = iconFor(entry.url);
      if (!icon) wantIcon(win.session, entry.url);
      return { url: entry.url, title: entry.title, icon, thumb: thumbnailFor(entry.url) };
    };
    const bookmarks = [...getBookmarks()].reverse().slice(0, 12);
    return { bookmarks: bookmarks.map(tile), visited: topSites(10).map(tile) };
  },
  chooseWallpaper: async (win) => {
    if (!(await chooseWallpaper(win.window))) return false;
    updateSettings({ wallpaper: `custom:${Date.now()}` });
    return true;
  },
  getWallpaperImage: () => wallpaperImage(),
  getPhotos: () => ({ photos: photoWallpapers(), turn: shuffledPhoto() }),

  getDownloads: () => getDownloads(),
  openDownload: (_win, id) => openDownload(id),
  showDownload: (_win, id) => showDownload(id),
  cancelDownload: (_win, id) => cancelDownload(id),
  clearDownloads: () => clearDownloads(),

  getFilterLists: () => {
    const settings = getSettings();
    const shared = catalog.lists
      .filter((list) => (!('platforms' in list) || list.platforms?.includes('android')) && !('group' in list && list.group === 'calm'))
      .map((list) => ({
        id: list.id,
        title: list.title,
        purpose: list.purpose,
        license: list.license,
        homepage: list.homepage,
        enabled: list.id === COOKIE_LIST_ID ? settings.shields.hideCookieBanners : !settings.disabledLists.includes(list.id),
      }));
    const own = {
      id: FIXES_LIST_ID,
      title: 'Stillweb fixes',
      purpose: 'Sites the other lists do not cover yet',
      license: 'Part of Stillweb',
      homepage: '',
      enabled: !settings.disabledLists.includes(FIXES_LIST_ID),
    };
    return [...shared, own];
  },
  setFilterListEnabled: (_win, id, enabled) => {
    const settings = getSettings();
    if (id === COOKIE_LIST_ID) return updateSettings({ shields: { ...settings.shields, hideCookieBanners: !!enabled } });
    const without = settings.disabledLists.filter((l) => l !== id);
    updateSettings({ disabledLists: enabled ? without : [...without, id] });
  },
  checkFilterUpdate: () => checkForFilterUpdate(true),
  getPrivacyReport: () => privacyReport(),
  resetPrivacyReport: () => resetPrivacyReport(),

  getAbout: () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    privacyUrl: PRIVACY_POLICY_URL,
  }),
  getLicenses: () => JSON.parse(fs.readFileSync(path.join(__dirname, 'licenses.json'), 'utf8')) as LicenseData,
  // Chromium's own notices ship as a file in the app's resources (see "extraResources").
  openChromiumLicenses: () => {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'LICENSES.chromium.html')
      : path.join(app.getAppPath(), 'node_modules/electron/dist/LICENSES.chromium.html');
    void shell.openPath(file);
  },
};

export function registerIpc(): void {
  for (const method of CHROME_METHODS) {
    ipcMain.handle(`chrome:${method}`, (event, ...args: unknown[]) => {
      const win = BrowserWin.forChrome(event.sender);
      if (!win) throw new Error('not the interface');
      return (handlers[method] as (win: BrowserWin, ...args: unknown[]) => unknown)(win, ...args);
    });
  }
}
