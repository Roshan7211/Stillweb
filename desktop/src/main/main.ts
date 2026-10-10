import { app, nativeTheme } from 'electron';

import { BrowserWin, onBrowsingSession, normalSession } from './browserWindow';
import { clearHistory, getBookmarks, loadData, onBookmarksChanged } from './data';
import { attachDownloads } from './downloads';
import { shieldEngine } from './engine/shieldEngine';
import { registerIpc } from './ipc';
import { loadFavicons, onIconStored } from './favicons';
import { loadMediaSites } from './mediaSites';
import { buildAppMenu, newWindow } from './menus';
import { SELF_TEST_PORT, runLiveCheck, runSelfTest } from './selfTest';
import { getSettings, loadSettings, onSettingsChanged } from './settings';
import { browserUserAgent, registerFrameHandlers, registerSchemes, setPopupSites } from './shields';
import { flushAll } from './store';
import { loadThumbnails } from './thumbnails';
import { scheduleFilterUpdates } from './updater';

const selfTest = process.argv.includes('--self-test');
/** `--live-check=<address>,<address>`: opens real pages and reports what was blocked on each. */
const liveCheck = process.argv.find((arg) => arg.startsWith('--live-check='))?.slice('--live-check='.length);
const testing = selfTest || liveCheck !== undefined;

// Tests keep their own data, so they never touch the real profile.
if (testing) app.setPath('userData', `${app.getPath('temp')}/stillweb-self-test-${process.pid}`);
if (selfTest) {
  // Every host name is this computer, where the test's web server answers for all of them.
  app.commandLine.appendSwitch('host-resolver-rules', `MAP * 127.0.0.1:${SELF_TEST_PORT}, EXCLUDE closed.invalid`);
}
if (testing) {
  // Tests play sound (to check what may start by itself); nobody should have to hear it.
  // Each tab is muted, which still lets the app see that it is playing.
  BrowserWin.muteNewTabs = true;
  // The test clicks in pages and takes pictures of them, also while its window is behind others.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion,CalculateNativeWinOcclusion');
}

// Electron's development-only console warnings are about pages this app does not control.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// One failed action must not take the browser (and every open tab) down with it, or stop
// with a dialog: it is logged and the app carries on.
process.on('uncaughtException', (error) => console.error('[stillweb] unexpected error:', error));
process.on('unhandledRejection', (reason) => console.error('[stillweb] unexpected rejection:', reason));

registerSchemes();

/** An address given on the command line (the app was asked to open a link). */
function urlFromArgs(argv: string[]): string | undefined {
  return argv.slice(1).find((arg) => /^https?:\/\//i.test(arg));
}

function openUrl(url?: string): void {
  const win = [...BrowserWin.all].find((w) => !w.isPrivate) ?? null;
  if (!win) {
    newWindow(false, url);
    return;
  }
  if (url) win.createTab({ url });
  if (win.window.isMinimized()) win.window.restore();
  win.window.focus();
}

function configureEngine(): void {
  const settings = getSettings();
  shieldEngine.configure(settings.shields, settings.disabledSites, settings.disabledLists);
  setPopupSites(settings.popupSites);
}

function broadcastEngineStatus(): void {
  for (const win of BrowserWin.all) win.send('engine-status', shieldEngine.status());
}

if (!testing && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => openUrl(urlFromArgs(argv)));
  // macOS hands links over with this event instead of the command line.
  let pendingUrl: string | undefined;
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) openUrl(url);
    else pendingUrl = url;
  });

  void app.whenReady().then(() => {
    app.userAgentFallback = browserUserAgent();
    loadSettings();
    loadData();
    loadMediaSites();
    loadFavicons();
    loadThumbnails();
    onIconStored(() => {
      for (const win of BrowserWin.all) win.send('home-changed', null);
    });
    configureEngine();
    registerFrameHandlers();
    registerIpc();
    buildAppMenu();
    onBrowsingSession(attachDownloads);

    onSettingsChanged((settings, previous) => {
      const blocking = (s: typeof settings) => JSON.stringify([s.shields, s.disabledSites, s.disabledLists, s.popupSites]);
      const shieldsChanged = blocking(settings) !== blocking(previous);
      if (shieldsChanged) configureEngine();
      nativeTheme.themeSource = settings.theme;
      for (const win of BrowserWin.all) {
        win.send('settings', settings);
        if (shieldsChanged) win.shieldsChanged();
        if (settings.theme !== previous.theme) win.applyTheme();
      }
    });
    nativeTheme.themeSource = getSettings().theme;
    nativeTheme.on('updated', () => {
      for (const win of BrowserWin.all) win.applyTheme();
    });
    shieldEngine.onChanged(broadcastEngineStatus);
    onBookmarksChanged(() => {
      for (const win of BrowserWin.all) win.send('bookmarks', getBookmarks());
    });

    // The window first, then the filters: pages wait for them (see BrowserWin.load).
    const first = new BrowserWin(false);
    const startUrl = pendingUrl ?? urlFromArgs(process.argv);
    const saved = BrowserWin.savedSession();
    if (!testing && getSettings().restoreTabs && saved.urls.length > 0) {
      const urls = [...saved.urls];
      const active = Math.min(Math.max(0, saved.active), urls.length - 1);
      // Only the tab in front loads now; the others load when they are first shown.
      urls.forEach((url, index) => first.createTab({ url, activate: index === active, asleep: true }));
      if (startUrl) first.createTab({ url: startUrl });
    } else {
      first.createTab({ url: startUrl });
    }
    // Loading the filters keeps this process busy for a moment: the window is drawn first.
    first.whenInterfaceReady(() => {
      shieldEngine.initialize();
      if (selfTest) void runSelfTest(first);
      else if (liveCheck !== undefined) void runLiveCheck(first, liveCheck.split(',').filter(Boolean));
      else scheduleFilterUpdates();
    });

    app.on('activate', () => {
      if (BrowserWin.all.size === 0) newWindow(false);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !app.isReady() || !getSettings().clearDataOnExit) return flushAll();
    // Forget everything first, then quit for real.
    quitting = true;
    event.preventDefault();
    clearHistory();
    flushAll();
    void normalSession()
      .clearData()
      .catch(() => {})
      .finally(() => app.quit());
  });
}
