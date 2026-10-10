// A browser window: the bars (one web view for the interface) above the active tab's page
// (one web view per tab).
import { BaseWindow, WebContentsView, dialog, nativeTheme, screen, session as electronSession, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';

import { resolveInput, searchUrl, siteKey } from '../../../src/browser/url';
import { themeFor } from '../shared/theme';
import type { ChromeEvents, LoadError, TabState, WindowState } from '../shared/types';
import { recordVisit, totalBlocked, totalUpgrades, updateVisitTitle } from './data';
import { shieldEngine } from './engine/shieldEngine';
import { rememberFavicon } from './favicons';
import { allowsAutoplay, rememberMediaSite } from './mediaSites';
import { showPageMenu } from './menus';
import { attachPermissions } from './permissions';
import { captureThumbnail, wantsThumbnail } from './thumbnails';
import { getSettings } from './settings';
import {
  attachShields,
  browserUserAgent,
  guardedNavigationBlocked,
  hadRecentGesture,
  httpFallback,
  markWatching,
  pageCommitted,
  pageInfo,
  popupDecision,
  refreshShieldsState,
  rememberOpener,
  shieldEvents,
  upgradeSettled,
  userAgentFor,
  type PopupGuard,
} from './shields';
import { jsonFile, type JsonFile } from './store';

const isMac = process.platform === 'darwin';
/** The height of the tab strip, which the system's window buttons are centered in. */
const TAB_STRIP_HEIGHT = 40;
const DEFAULT_BAR_HEIGHT = 86;
/** Chromium's code for a load that was stopped on purpose (by the user or a new navigation). */
const ERR_ABORTED = -3;
/** Sound that plays this long counts as the user listening to the site (see mediaSites.ts). */
const LISTENING_MS = 7000;

// ---------------------------------------------------------------------------
// Sessions: one for normal windows (kept on disk), one for private windows (memory only).

const preparedSessions = new WeakSet<Session>();

function prepare(session: Session): Session {
  if (!preparedSessions.has(session)) {
    preparedSessions.add(session);
    session.setUserAgent(browserUserAgent());
    attachShields(session);
    attachPermissions(session);
    for (const listener of sessionListeners) listener(session);
  }
  return session;
}

const sessionListeners: ((session: Session) => void)[] = [];
/** Runs for every browsing session, now and when one is created later (downloads use it). */
export function onBrowsingSession(listener: (session: Session) => void): void {
  sessionListeners.push(listener);
}

export function normalSession(): Session {
  return prepare(electronSession.fromPartition('persist:stillweb'));
}

function privateSession(): Session {
  return prepare(electronSession.fromPartition('private'));
}

// ---------------------------------------------------------------------------

let nextTabId = 1;

class Tab {
  readonly id = nextTabId++;
  url = '';
  title = '';
  favicon: string | null = null;
  loading = false;
  error: LoadError | null = null;
  audible = false;
  /** Whether a page ever loaded here (a tab that only started a download is closed again). */
  committed = false;
  /** A tab from last time that has not been opened yet: its page loads when it is first shown. */
  asleep = false;
  listeningTimer: NodeJS.Timeout | null = null;
  pictureTimer: NodeJS.Timeout | null = null;
  /** Set on a window a page opened: its first addresses are still checked (see shields.ts). */
  popupGuard: PopupGuard | null = null;

  constructor(readonly view: WebContentsView) {}

  get contents(): WebContents {
    return this.view.webContents;
  }

  state(): TabState {
    const contents = this.contents;
    const info = pageInfo(contents);
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      secure: this.url.startsWith('https://'),
      shieldsActive: this.url ? info.shieldsActive : shieldEngine.options.enabled,
      blocked: info.blocked,
      popupsBlocked: info.popups.count,
      lastPopup: info.popups.last,
      audible: this.audible,
      muted: contents.isAudioMuted(),
      error: this.error,
      zoom: Math.round(contents.getZoomFactor() * 100),
    };
  }
}

type SavedWindow = { bounds?: { x: number; y: number; width: number; height: number }; maximized?: boolean };
type SavedSession = { urls: string[]; active: number };

let windowFile: JsonFile<SavedWindow> | null = null;
let sessionFile: JsonFile<SavedSession> | null = null;

/** Drops a saved position that no screen shows any more (a monitor that was unplugged). */
function onScreen(saved: SavedWindow): SavedWindow {
  const b = saved.bounds;
  if (!b) return saved;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80);
  return visible ? saved : { maximized: saved.maximized };
}

export class BrowserWin {
  static readonly all = new Set<BrowserWin>();
  /** Set by the tests, which play sound that nobody should have to hear. */
  static muteNewTabs = false;
  private static lastFocused: BrowserWin | null = null;

  /** The window in front, for menu commands. */
  static focused(): BrowserWin | null {
    const current = BrowserWin.lastFocused;
    return current && BrowserWin.all.has(current) ? current : (BrowserWin.all.values().next().value ?? null);
  }

  static forChrome(contents: WebContents): BrowserWin | null {
    for (const win of BrowserWin.all) if (win.chrome.webContents === contents) return win;
    return null;
  }

  static forTab(contents: WebContents): { win: BrowserWin; tab: Tab } | null {
    for (const win of BrowserWin.all) {
      const tab = win.tabs.find((t) => t.contents === contents);
      if (tab) return { win, tab };
    }
    return null;
  }

  /** The tabs to open at startup, from last time. */
  static savedSession(): SavedSession {
    sessionFile ??= jsonFile<SavedSession>('session.json', { urls: [], active: 0 });
    return sessionFile.value;
  }

  readonly window: BaseWindow;
  readonly chrome: WebContentsView;
  readonly session: Session;
  tabs: Tab[] = [];
  private activeId = 0;
  private barHeight = DEFAULT_BAR_HEIGHT;
  private expanded = false;
  /** The tab whose page has taken the whole screen (a video in full screen), if any. */
  private fullscreenTab: Tab | null = null;
  private statePending = false;
  private blockedTimer: NodeJS.Timeout | null = null;
  private closedUrls: string[] = [];
  private dragTimer: NodeJS.Timeout | null = null;
  private chromeReady = false;
  private readonly queued: (() => void)[] = [];

  constructor(readonly isPrivate = false) {
    windowFile ??= jsonFile<SavedWindow>('window.json', {});
    const saved = isPrivate || BrowserWin.all.size > 0 ? {} : onScreen(windowFile.value);
    this.session = isPrivate ? privateSession() : normalSession();
    const theme = this.theme();

    this.window = new BaseWindow({
      width: 1280,
      height: 860,
      ...saved.bounds,
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: 'Stillweb',
      backgroundColor: theme.background,
      // The tabs sit in the title bar; the system still draws the window buttons.
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 14, y: (TAB_STRIP_HEIGHT - 16) / 2 } }
        : { titleBarOverlay: { color: theme.surface, symbolColor: theme.text, height: TAB_STRIP_HEIGHT } }),
    });
    // Windows would draw the menu bar inside the window; its shortcuts work without it.
    if (!isMac) this.window.setMenuBarVisibility(false);
    if (saved.maximized) this.window.maximize();

    this.chrome = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-chrome.js'),
        sandbox: true,
        contextIsolation: true,
        // Lists and panels are drawn over the page, which shows through the rest.
        transparent: true,
      },
    });
    this.chrome.setBackgroundColor('#00000000');
    this.window.contentView.addChildView(this.chrome);
    const chromeContents = this.chrome.webContents;
    // The interface is one local page: it never navigates and never opens windows.
    chromeContents.on('will-navigate', (event) => event.preventDefault());
    chromeContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Normally the interface reports in (see interfaceReady); if it never does, the window
    // still appears.
    chromeContents.once('did-finish-load', () => setTimeout(() => this.interfaceReady(), 2000));
    // If the interface's own process dies, it is started again; the tabs are not affected.
    chromeContents.on('render-process-gone', () => {
      if (!this.window.isDestroyed()) setTimeout(() => !chromeContents.isDestroyed() && chromeContents.reload(), 200);
    });
    void chromeContents.loadFile(path.join(__dirname, 'renderer/index.html'));

    this.window.on('resize', () => this.layout());
    this.window.on('focus', () => {
      BrowserWin.lastFocused = this;
    });
    this.window.on('enter-full-screen', () => this.pushState());
    this.window.on('leave-full-screen', () => this.pushState());
    this.window.on('close', () => this.saveBounds());
    this.window.on('closed', () => this.destroyed());

    BrowserWin.all.add(this);
    BrowserWin.lastFocused = this;
    this.layout();
  }

  /**
   * The interface has drawn itself and is listening: messages that were waiting for it
   * (the first "put the cursor in the address bar", for one) are delivered now.
   */
  interfaceReady(): void {
    if (this.chromeReady || this.window.isDestroyed()) return;
    this.chromeReady = true;
    for (const action of this.queued.splice(0)) action();
    this.window.show();
    // Whatever was waiting for the first picture (loading the filters) starts after it.
    setTimeout(() => {
      for (const action of this.afterReady.splice(0)) action();
    }, 30);
  }

  private readonly afterReady: (() => void)[] = [];

  /** Runs `action` once the window is on screen (right away if it already is). */
  whenInterfaceReady(action: () => void): void {
    if (this.chromeReady) action();
    else this.afterReady.push(action);
  }

  theme() {
    const setting = getSettings().theme;
    const dark = setting === 'system' ? nativeTheme.shouldUseDarkColors : setting === 'dark';
    return themeFor(dark, this.isPrivate);
  }

  /** After the theme setting or the system appearance changed. */
  applyTheme(): void {
    const theme = this.theme();
    this.window.setBackgroundColor(theme.background);
    if (!isMac) this.window.setTitleBarOverlay({ color: theme.surface, symbolColor: theme.text, height: TAB_STRIP_HEIGHT });
    this.pushState();
  }

  // ---------------------------------------------------------------------------
  // Messages to the interface

  send<K extends keyof ChromeEvents>(channel: K, payload: ChromeEvents[K]): void {
    const deliver = () => {
      if (!this.chrome.webContents.isDestroyed()) this.chrome.webContents.send(channel, payload);
    };
    if (this.chromeReady) deliver();
    else this.queued.push(deliver);
  }

  state(): WindowState {
    return {
      tabs: this.tabs.map((tab) => tab.state()),
      activeId: this.activeId,
      private: this.isPrivate,
      fullscreen: this.window.isFullScreen(),
      windowButtons: this.window.isFullScreen() ? 'none' : isMac ? 'left' : 'right',
      systemDark: nativeTheme.shouldUseDarkColors,
      totalBlocked: totalBlocked(),
      totalUpgrades: totalUpgrades(),
    };
  }

  /** Sends the tabs' state to the interface; many changes in one turn become one message. */
  pushState(): void {
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      if (!BrowserWin.all.has(this)) return;
      this.send('window-state', this.state());
      this.saveSession();
    });
  }

  /** Blocked counters change with every request: at most one update per quarter second. */
  private pushBlocked(): void {
    this.blockedTimer ??= setTimeout(() => {
      this.blockedTimer = null;
      this.pushState();
    }, 250);
  }

  // ---------------------------------------------------------------------------
  // Layout

  setLayout(barHeight: number, expanded: boolean): void {
    this.barHeight = Math.max(TAB_STRIP_HEIGHT, Math.min(400, Math.round(barHeight)));
    this.expanded = expanded;
    this.layout();
  }

  private layout(): void {
    const [width, height] = this.window.getContentSize();
    const active = this.activeTab;
    if (this.fullscreenTab && this.fullscreenTab === active) {
      // A page's video in full screen covers the bars too.
      this.chrome.setVisible(false);
      for (const tab of this.tabs) tab.view.setVisible(tab === active);
      active.view.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    this.chrome.setVisible(true);
    const bar = Math.min(this.barHeight, height);
    this.chrome.setBounds(this.expanded ? { x: 0, y: 0, width, height } : { x: 0, y: 0, width, height: bar });
    for (const tab of this.tabs) {
      // A new tab and a failed page are drawn by the interface, not by the page's view.
      const visible = tab === active && tab.url !== '' && !tab.error;
      tab.view.setVisible(visible);
      if (visible) tab.view.setBounds({ x: 0, y: bar, width, height: Math.max(0, height - bar) });
    }
  }

  /**
   * The empty part of the tab strip is the window's title bar. Normally the system moves the
   * window for a press there and the interface never hears of it; if the press does reach the
   * interface, it asks for this instead: the window follows the pointer until the button is
   * released (or, in case that is never reported, for a few seconds at most).
   */
  dragWindow(active: boolean): void {
    if (this.dragTimer) clearInterval(this.dragTimer);
    this.dragTimer = null;
    if (!active || this.window.isFullScreen() || this.window.isMaximized()) return;
    const start = screen.getCursorScreenPoint();
    const [x, y] = this.window.getPosition();
    const started = Date.now();
    this.dragTimer = setInterval(() => {
      if (this.window.isDestroyed() || Date.now() - started > 8000) return this.dragWindow(false);
      const now = screen.getCursorScreenPoint();
      this.window.setPosition(x + now.x - start.x, y + now.y - start.y);
    }, 16);
  }

  // ---------------------------------------------------------------------------
  // Tabs

  get activeTab(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  /**
   * Opens a tab. `adopt` is the web contents Chromium made for a window a page opened, which
   * keeps the new page connected to the one that opened it.
   */
  createTab(options: { url?: string; activate?: boolean; adopt?: WebContents; afterId?: number; asleep?: boolean } = {}): Tab {
    const view = new WebContentsView(
      options.adopt
        ? { webContents: options.adopt }
        : {
            webPreferences: {
              session: this.session,
              sandbox: true,
              contextIsolation: true,
              // The preload script (cosmetic filters, scriptlets) runs in every frame.
              nodeIntegrationInSubFrames: true,
              // As in other browsers: sound does not start until the user has used the page.
              autoplayPolicy: 'document-user-activation-required',
            },
          },
    );
    const tab = new Tab(view);
    view.setBackgroundColor('#FFFFFF');
    if (BrowserWin.muteNewTabs) view.webContents.setAudioMuted(true);
    // Below the interface, which is always the last (topmost) child.
    this.window.contentView.addChildView(view, 0);
    const after = this.tabs.findIndex((t) => t.id === options.afterId);
    if (after >= 0) this.tabs.splice(after + 1, 0, tab);
    else this.tabs.push(tab);
    this.wire(tab);
    if (options.url && options.asleep) {
      tab.url = options.url;
      tab.asleep = true;
    }
    if (options.activate !== false || (!this.activeTab && !options.asleep)) this.activate(tab.id);
    if (options.url && !options.asleep) this.load(tab, options.url);
    this.layout();
    this.pushState();
    return tab;
  }

  private wire(tab: Tab): void {
    const contents = tab.contents;

    contents.setWindowOpenHandler((details) => {
      const guard = popupDecision(contents, details.url);
      if (!guard) return { action: 'deny' };
      rememberOpener(contents);
      const background = details.disposition === 'background-tab';
      return {
        action: 'allow',
        createWindow: (created) => {
          const adopt = (created as { webContents?: WebContents }).webContents;
          const opened = this.createTab({ adopt, activate: !background, afterId: tab.id, url: adopt ? undefined : details.url });
          opened.popupGuard = guard;
          if (!opened.url) opened.url = details.url;
          return opened.contents;
        },
      };
    });

    // Links to other apps (mailto:, tel:, ...) are handed to the system, but only when the
    // user just clicked: a page cannot launch another app by itself.
    contents.on('will-navigate', (event, url) => {
      if (/^(https?|about|blob|data|file|view-source|chrome|devtools):/i.test(url)) return;
      event.preventDefault();
      if (/^(mailto|tel|sms):/i.test(url) && hadRecentGesture(contents)) void shell.openExternal(url);
    });

    contents.on('did-start-loading', () => {
      tab.loading = true;
      this.pushState();
    });
    contents.on('did-stop-loading', () => {
      tab.loading = false;
      // A navigation that never arrived (it became a download, or was stopped): the address
      // goes back to the page that is still showing.
      if (tab.committed && !tab.error) {
        const shown = contents.getURL();
        if (shown) {
          tab.url = shown;
          pageCommitted(contents, shown);
        }
        this.pictureLater(tab);
      }
      this.pushState();
    });
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // A window a page opened that turns out to be an ad is closed before it shows anything.
      if (tab.popupGuard && guardedNavigationBlocked(tab.popupGuard, contents, details.url)) {
        this.closeTab(tab.id, false);
        return;
      }
      // A few sites get the browser's own name (see userAgentFor); the page, its workers and
      // its requests all follow the tab's setting.
      const agent = userAgentFor(details.url);
      if (contents.getUserAgent() !== agent) contents.setUserAgent(agent);
      if (process.argv.includes('--log-shields')) console.log('[shields] navigation', details.url, 'from', details.initiator?.url ?? '-');
      // The address appears as soon as the page is asked for, as in any browser.
      if (/^https?:/i.test(details.url)) tab.url = details.url;
      tab.error = null;
      this.layout();
      this.pushState();
    });
    contents.on('did-navigate', (_event, url) => {
      tab.committed = true;
      tab.url = url === 'about:blank' ? tab.url : url;
      tab.error = null;
      tab.favicon = null;
      tab.title = '';
      upgradeSettled(contents);
      // On a site the user plays media on, the page in front may start by itself: it gets
      // the same standing a click in the page would give it.
      if (tab === this.activeTab && allowsAutoplay(url)) void contents.mainFrame.executeJavaScript('void 0', true).catch(() => {});
      if (!this.isPrivate) recordVisit(url, '');
      this.layout();
      this.pushState();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (!this.isPrivate) recordVisit(url, tab.title);
      this.pushState();
    });
    contents.on('page-title-updated', (_event, title) => {
      tab.title = title;
      if (!this.isPrivate) updateVisitTitle(tab.url, title);
      this.pushState();
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons.find((icon) => /^https?:|^data:image\//i.test(icon)) ?? null;
      if (tab.favicon && !this.isPrivate) rememberFavicon(this.session, tab.url, tab.favicon);
      this.pushState();
    });
    contents.on('audio-state-changed', (event) => {
      tab.audible = event.audible;
      if (event.audible) markWatching(contents);
      if (tab.listeningTimer) clearTimeout(tab.listeningTimer);
      tab.listeningTimer = null;
      if (event.audible && !this.isPrivate) {
        tab.listeningTimer = setTimeout(() => {
          tab.listeningTimer = null;
          if (!contents.isDestroyed()) rememberMediaSite(contents.getURL());
        }, LISTENING_MS);
      }
      this.pushState();
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      const fallback = httpFallback(contents, url, code);
      if (fallback) {
        void contents.loadURL(fallback).catch(() => {});
        return;
      }
      tab.error = { url, code, description };
      tab.url = url;
      tab.title = '';
      tab.favicon = null;
      tab.loading = false;
      this.layout();
      this.pushState();
    });
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      tab.error = { url: tab.url, code: -10001, description: details.reason === 'oom' ? 'PAGE_OUT_OF_MEMORY' : 'PAGE_CRASHED' };
      tab.loading = false;
      this.layout();
      this.pushState();
    });
    contents.on('found-in-page', (_event, result) => {
      if (tab === this.activeTab) this.send('find-result', { active: result.activeMatchOrdinal, count: result.matches });
    });
    contents.on('enter-html-full-screen', () => {
      this.fullscreenTab = tab;
      this.layout();
    });
    contents.on('leave-html-full-screen', () => {
      if (this.fullscreenTab === tab) this.fullscreenTab = null;
      this.layout();
    });
    contents.on('zoom-changed', (_event, direction) => this.zoom(direction === 'in' ? 1 : -1));
    contents.on('context-menu', (_event, params) => showPageMenu(this, tab.id, params));
    contents.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(this.window, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave this page?',
        detail: 'Changes you made may not be saved.',
      });
      if (choice === 0) event.preventDefault();
    });
    // The page called window.close().
    contents.on('destroyed', () => this.forget(tab));
  }

  /**
   * A moment after a page has loaded in the tab in front, its picture is taken for the home
   * page (once per site every few hours; never in private windows).
   */
  private pictureLater(tab: Tab, attempt = 1): void {
    if (tab.pictureTimer) clearTimeout(tab.pictureTimer);
    tab.pictureTimer = null;
    const url = tab.url;
    if (this.isPrivate || tab !== this.activeTab || !wantsThumbnail(url)) return;
    tab.pictureTimer = setTimeout(() => {
      tab.pictureTimer = null;
      // Still the same site in front? (Pages change their own address; the site is what counts.)
      const sameSite = siteKey(tab.url) === siteKey(url);
      if (tab !== this.activeTab || !sameSite || tab.error || tab.contents.isDestroyed() || !this.window.isVisible() || this.fullscreenTab) return;
      // Some pages go on loading for a while: wait for them a little, then take what is there.
      if (tab.loading && attempt < 3) return this.pictureLater(tab, attempt + 1);
      void captureThumbnail(tab.contents, tab.url)
        .then(() => {
          for (const win of BrowserWin.all) win.send('home-changed', null);
        })
        .catch(() => {});
    }, attempt === 1 ? 1800 : 1200);
  }

  /** Loads an address once the filters are ready, so the first page is not left unfiltered. */
  private load(tab: Tab, url: string): void {
    tab.asleep = false;
    tab.url = url;
    tab.error = null;
    tab.loading = true;
    this.layout();
    this.pushState();
    shieldEngine.whenReady(() => {
      if (tab.contents.isDestroyed()) return;
      // A failed load is reported through did-fail-load.
      void tab.contents.loadURL(url).catch(() => {});
    });
  }

  /** Address bar input (an address or a search) in the active tab. */
  navigate(input: string): void {
    const settings = getSettings();
    let url = resolveInput(input, settings.searchEngine, settings.customSearchTemplate);
    // Script pasted into the address bar would run inside the open page: search for it instead.
    if (/^\s*javascript:/i.test(url)) url = searchUrl(input, settings.searchEngine, settings.customSearchTemplate);
    if (!url) return;
    const tab = this.activeTab ?? this.createTab();
    this.load(tab, url);
    tab.contents.focus();
  }

  activate(id: number): void {
    if (!this.tabs.some((tab) => tab.id === id)) return;
    // Another tab comes to the front: a page in full screen gives the screen back.
    const full = this.fullscreenTab;
    if (full && full.id !== id && !full.contents.isDestroyed()) {
      void full.contents.executeJavaScript('document.exitFullscreen()', true).catch(() => {});
    }
    this.activeId = id;
    const tab = this.activeTab;
    if (tab?.asleep) this.load(tab, tab.url);
    this.layout();
    this.pushState();
    if (tab && tab.url) tab.contents.focus();
    else this.focusAddress('new-tab');
  }

  activateRelative(step: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    if (index < 0 || this.tabs.length < 2) return;
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length].id);
  }

  activateIndex(index: number): void {
    const tab = index >= this.tabs.length || index < 0 ? this.tabs[this.tabs.length - 1] : this.tabs[index];
    if (tab) this.activate(tab.id);
  }

  moveTab(id: number, toIndex: number): void {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, toIndex)), 0, tab);
    this.pushState();
  }

  /** `remember`: whether "Reopen Closed Tab" can bring it back (not for windows that were ads). */
  closeTab(id: number, remember = true): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (remember && tab.url && !this.isPrivate) {
      this.closedUrls.push(tab.url);
      if (this.closedUrls.length > 25) this.closedUrls.shift();
    }
    // Removes it from the list (see forget) once its contents are gone.
    tab.contents.close({ waitForBeforeUnload: false });
    if (!tab.contents.isDestroyed()) this.forget(tab);
  }

  closeOtherTabs(id: number): void {
    for (const tab of [...this.tabs]) if (tab.id !== id) this.closeTab(tab.id);
  }

  private forget(tab: Tab): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    if (tab.listeningTimer) clearTimeout(tab.listeningTimer);
    if (tab.pictureTimer) clearTimeout(tab.pictureTimer);
    if (this.fullscreenTab === tab) this.fullscreenTab = null;
    this.tabs.splice(index, 1);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (this.tabs.length === 0) {
      // The last tab takes the window with it, as in other browsers.
      if (!this.window.isDestroyed()) this.window.close();
      return;
    }
    if (this.activeId === tab.id) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
    this.layout();
    this.pushState();
  }

  /** A navigation in this tab became a download: a tab that shows nothing else is a new tab again. */
  downloadStarted(tab: Tab): void {
    if (tab.committed) return;
    if (this.tabs.length > 1) return this.closeTab(tab.id);
    tab.url = '';
    tab.loading = false;
    this.layout();
    this.pushState();
  }

  reopenClosedTab(): void {
    const url = this.closedUrls.pop();
    if (url) this.createTab({ url });
  }

  // ---------------------------------------------------------------------------
  // Commands for the active tab

  goBack(): void {
    const tab = this.activeTab;
    if (tab?.contents.navigationHistory.canGoBack()) tab.contents.navigationHistory.goBack();
  }

  goForward(): void {
    const tab = this.activeTab;
    if (tab?.contents.navigationHistory.canGoForward()) tab.contents.navigationHistory.goForward();
  }

  /** Reloads the active tab, or the tab with this id. */
  reload(ignoreCache = false, id = this.activeId): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || !tab.url) return;
    // A page that failed, or never loaded, is asked for again by its address.
    if (tab.error || !tab.committed) this.load(tab, tab.url);
    else if (ignoreCache) tab.contents.reloadIgnoringCache();
    else tab.contents.reload();
  }

  stop(): void {
    this.activeTab?.contents.stop();
  }

  zoom(step: number): void {
    const contents = this.activeTab?.contents;
    if (!contents) return;
    const levels = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    if (step === 0) {
      contents.setZoomFactor(1);
    } else {
      const current = contents.getZoomFactor();
      const next = step > 0 ? levels.find((level) => level > current + 0.01) : [...levels].reverse().find((level) => level < current - 0.01);
      if (next) contents.setZoomFactor(next);
    }
    this.pushState();
  }

  toggleMute(id: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.contents.setAudioMuted(!tab.contents.isAudioMuted());
    this.pushState();
  }

  focusAddress(reason: 'new-tab' | 'shortcut' = 'shortcut'): void {
    this.chrome.webContents.focus();
    this.send('focus-address', reason);
  }

  openFind(): void {
    if (!this.activeTab?.url) return;
    this.chrome.webContents.focus();
    this.send('open-find', null);
  }

  toggleDevTools(): void {
    this.activeTab?.contents.toggleDevTools();
  }

  print(): void {
    this.activeTab?.contents.print();
  }

  /** Shields were turned on or off (for a site or everywhere): open pages show the new state. */
  shieldsChanged(): void {
    for (const tab of this.tabs) refreshShieldsState(tab.contents);
    this.pushState();
  }

  // ---------------------------------------------------------------------------
  // Remembering between runs

  private saveBounds(): void {
    if (this.isPrivate || !windowFile) return;
    windowFile.value = { bounds: this.window.getNormalBounds(), maximized: this.window.isMaximized() };
    windowFile.changed();
  }

  private saveSession(): void {
    if (this.isPrivate || !sessionFile || BrowserWin.focused() !== this) return;
    const tabs = this.tabs.filter((tab) => /^https?:/i.test(tab.url));
    sessionFile.value = { urls: tabs.map((tab) => tab.url), active: Math.max(0, tabs.findIndex((tab) => tab.id === this.activeId)) };
    sessionFile.changed();
  }

  private destroyed(): void {
    BrowserWin.all.delete(this);
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    if (this.dragTimer) clearInterval(this.dragTimer);
    for (const tab of this.tabs.splice(0)) {
      if (tab.listeningTimer) clearTimeout(tab.listeningTimer);
      if (tab.pictureTimer) clearTimeout(tab.pictureTimer);
      if (!tab.contents.isDestroyed()) tab.contents.close({ waitForBeforeUnload: false });
    }
    if (!this.chrome.webContents.isDestroyed()) this.chrome.webContents.close();
    // Nothing from private windows outlives the last of them.
    if (this.isPrivate && ![...BrowserWin.all].some((win) => win.isPrivate)) {
      void this.session.clearData().catch(() => {});
    }
  }

  /** Called by the shield events below. */
  blockedChanged(): void {
    this.pushBlocked();
  }
}

shieldEvents.on('blocked', (contentsId: number) => {
  for (const win of BrowserWin.all) {
    if (win.tabs.some((tab) => tab.contents.id === contentsId)) win.blockedChanged();
  }
});
