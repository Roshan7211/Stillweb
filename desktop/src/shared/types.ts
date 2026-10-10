// Types shared by the main process, the preload scripts and the window's interface.
import type { RemoteSuggestion } from '../../../src/browser/suggestEndpoints';
import type { SearchEngineId } from '../../../src/browser/url';

export type { RemoteSuggestion, SearchEngineId };

export type ShieldSettings = {
  enabled: boolean;
  httpsUpgrade: boolean;
  blockPopups: boolean;
  cosmeticFiltering: boolean;
  blockThirdPartyCookies: boolean;
  /** Includes the EasyList Cookie List (the engine is rebuilt without it when off). */
  hideCookieBanners: boolean;
};

export type Settings = {
  searchEngine: SearchEngineId;
  customSearchTemplate: string;
  theme: 'system' | 'light' | 'dark';
  shields: ShieldSettings;
  /** Sites (host, without www.) where shields are off. */
  disabledSites: string[];
  /** Filter lists (ids from the catalog) the user turned off. */
  disabledLists: string[];
  /** Ask the search engine for suggestions while typing (never in private windows). */
  searchSuggestions: boolean;
  /** Open the tabs from last time when the app starts. */
  restoreTabs: boolean;
  /** Forget history, cookies and site data when the app quits. */
  clearDataOnExit: boolean;
};

export type LoadError = { url: string; code: number; description: string };

export type TabState = {
  id: number;
  /** '' for a new tab that has not opened a page yet. */
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
  /** False when shields are off globally or for this site. */
  shieldsActive: boolean;
  /** Requests blocked on the current page. */
  blocked: number;
  audible: boolean;
  muted: boolean;
  error: LoadError | null;
  /** Zoom in percent (100 = normal). */
  zoom: number;
};

export type WindowState = {
  tabs: TabState[];
  activeId: number;
  private: boolean;
  fullscreen: boolean;
  /** Where the system draws the window buttons, so the tab strip can leave room for them. */
  windowButtons: 'left' | 'right' | 'none';
  /** The system appearance, for the "system" theme. */
  systemDark: boolean;
  /** Requests blocked since the app was first used (or the report was reset). */
  totalBlocked: number;
};

export type EngineStatus = {
  ready: boolean;
  version: string | null;
  source: 'bundled' | 'downloaded' | 'none';
  buildMillis: number;
  lastError: string | null;
};

export type Bookmark = { url: string; title: string; added: number };
export type HistoryEntry = { url: string; title: string; time: number };

export type DownloadState = {
  id: number;
  url: string;
  filename: string;
  path: string;
  received: number;
  /** 0 when the server did not say. */
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  started: number;
};

export type Suggestion =
  | { kind: 'search'; text: string }
  | { kind: 'site'; url: string; title: string }
  | { kind: 'history' | 'bookmark'; url: string; title: string };

export type FilterListInfo = { id: string; title: string; purpose: string; license: string; homepage: string; enabled: boolean };

export type PrivacyReport = {
  totalBlocked: number;
  /** Hosts that were blocked most, most first. */
  hosts: { host: string; count: number }[];
  /** Blocked requests per day (local date, YYYY-MM-DD), oldest first, the last 14 days. */
  days: { day: string; count: number }[];
};

export type LicenseData = { components: { name: string; license: string; text: string }[]; texts: Record<string, string> };

export type AboutInfo = { version: string; electron: string; chromium: string; privacyUrl: string | null };

export type Panel = 'settings' | 'history' | 'bookmarks' | 'downloads' | 'privacy' | 'about';

export type FindResult = { active: number; count: number };

/** What the window's interface can ask the main process to do (`window.stillweb`). */
export type ChromeApi = {
  /** The interface is drawn and listening for messages. */
  interfaceReady(): Promise<void>;
  getWindowState(): Promise<WindowState>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  getEngineStatus(): Promise<EngineStatus>;

  /** The height of the bars, and whether the interface needs the whole window (a panel or list is open). */
  setLayout(layout: { barHeight: number; expanded: boolean }): Promise<void>;
  /**
   * Moves the window with the pointer until `active` is false. Only used when the system does
   * not move the window itself for a press on the empty part of the tab strip.
   */
  dragWindow(active: boolean): Promise<void>;
  toggleMaximize(): Promise<void>;

  newTab(url?: string): Promise<void>;
  closeTab(id: number): Promise<void>;
  activateTab(id: number): Promise<void>;
  moveTab(id: number, toIndex: number): Promise<void>;
  toggleMute(id: number): Promise<void>;
  /** Opens address bar input (an address or a search) in the active tab. */
  navigate(input: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  focusPage(): Promise<void>;

  setSiteShields(site: string, enabled: boolean): Promise<void>;
  suggest(query: string): Promise<Suggestion[]>;

  findInPage(text: string, forward: boolean, next: boolean): Promise<void>;
  stopFind(): Promise<void>;

  /** Shows the app's menu as a native menu at this point of the window. */
  showAppMenu(x: number, y: number): Promise<void>;
  showTabMenu(id: number, x: number, y: number): Promise<void>;

  getBookmarks(): Promise<Bookmark[]>;
  setBookmarked(url: string, title: string, bookmarked: boolean): Promise<void>;
  getHistory(query: string): Promise<HistoryEntry[]>;
  removeHistory(url: string, time: number): Promise<void>;
  clearBrowsingData(): Promise<void>;
  getTopSites(): Promise<{ url: string; title: string }[]>;

  getDownloads(): Promise<DownloadState[]>;
  openDownload(id: number): Promise<void>;
  showDownload(id: number): Promise<void>;
  cancelDownload(id: number): Promise<void>;
  clearDownloads(): Promise<void>;

  getFilterLists(): Promise<FilterListInfo[]>;
  setFilterListEnabled(id: string, enabled: boolean): Promise<void>;
  checkFilterUpdate(): Promise<string>;
  getPrivacyReport(): Promise<PrivacyReport>;
  resetPrivacyReport(): Promise<void>;

  getAbout(): Promise<AboutInfo>;
  getLicenses(): Promise<LicenseData>;
  openChromiumLicenses(): Promise<void>;
};

/** Messages from the main process to the window's interface. */
export type ChromeEvents = {
  'window-state': WindowState;
  settings: Settings;
  'engine-status': EngineStatus;
  /** Put the cursor in the address bar (Ctrl/Cmd+L, or a new tab). */
  'focus-address': null;
  'open-find': null;
  'find-result': FindResult;
  'open-panel': Panel;
  downloads: DownloadState[];
  bookmarks: Bookmark[];
};

export const CHROME_METHODS: (keyof ChromeApi)[] = [
  'interfaceReady', 'getWindowState', 'getSettings', 'setSettings', 'getEngineStatus', 'setLayout', 'dragWindow', 'toggleMaximize',
  'newTab', 'closeTab', 'activateTab', 'moveTab', 'toggleMute', 'navigate', 'goBack', 'goForward', 'reload', 'stop', 'focusPage',
  'setSiteShields', 'suggest', 'findInPage', 'stopFind', 'showAppMenu', 'showTabMenu',
  'getBookmarks', 'setBookmarked', 'getHistory', 'removeHistory', 'clearBrowsingData', 'getTopSites',
  'getDownloads', 'openDownload', 'showDownload', 'cancelDownload', 'clearDownloads',
  'getFilterLists', 'setFilterListEnabled', 'checkFilterUpdate', 'getPrivacyReport', 'resetPrivacyReport',
  'getAbout', 'getLicenses', 'openChromiumLicenses',
];

/** What a page frame's preload script gets, before the page's own scripts run. */
export type FrameStart = {
  /** Runs in the page's own world: browser objects Electron lacks, Global Privacy Control and the site's scriptlets. */
  pageScript: string;
  /** For web/shieldjs/cosmetic-host.js, or null when the site has no rules of its own. */
  cosmetic: { hide: string[]; procedural: string[] } | null;
  /** Generic (class and id) hiding is on for this frame. */
  generic: boolean;
};
