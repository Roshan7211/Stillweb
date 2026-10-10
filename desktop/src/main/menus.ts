// The menu bar (and its keyboard shortcuts), the toolbar's menu, and the right-click menus.
import { Menu, app, clipboard, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

import { searchUrl } from '../../../src/browser/url';
import type { Panel } from '../shared/types';
import { BrowserWin } from './browserWindow';
import { isBookmarked, setBookmarked } from './data';
import { getSettings } from './settings';

const isMac = process.platform === 'darwin';

/** Runs a command in the window in front. */
const inWindow = (action: (win: BrowserWin) => void) => () => {
  const win = BrowserWin.focused();
  if (win) action(win);
};

function openPanel(panel: Panel) {
  return inWindow((win) => {
    win.chrome.webContents.focus();
    win.send('open-panel', panel);
  });
}

function toggleBookmark(win: BrowserWin): void {
  const tab = win.activeTab;
  if (!tab || !/^https?:/i.test(tab.url)) return;
  setBookmarked(tab.url, tab.title, !isBookmarked(tab.url));
}

export function newWindow(isPrivate: boolean, url?: string): BrowserWin {
  const win = new BrowserWin(isPrivate);
  win.createTab({ url });
  return win;
}

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: 'About Stillweb', click: openPanel('about') },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: openPanel('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: inWindow((win) => win.createTab()) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => newWindow(false) },
        { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow(true) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: inWindow((win) => win.reopenClosedTab()) },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: inWindow((win) => win.focusAddress()) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: inWindow((win) => win.activeTab && win.closeTab(win.activeTab.id)) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: inWindow((win) => win.window.close()) },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: inWindow((win) => win.print()) },
        ...(isMac ? [] : ([{ type: 'separator' }, { label: 'Settings', accelerator: 'Ctrl+,', click: openPanel('settings') }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: inWindow((win) => win.openFind()) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: inWindow((win) => win.reload()) },
        { label: 'Reload Without Cache', accelerator: 'CmdOrCtrl+Shift+R', click: inWindow((win) => win.reload(true)) },
        { label: 'Stop', accelerator: 'Esc', registerAccelerator: false, click: inWindow((win) => win.stop()) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: inWindow((win) => win.zoom(1)) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: inWindow((win) => win.zoom(1)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: inWindow((win) => win.zoom(-1)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: inWindow((win) => win.zoom(0)) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: inWindow((win) => win.toggleDevTools()) },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: inWindow((win) => win.goBack()) },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: inWindow((win) => win.goForward()) },
        { type: 'separator' },
        { label: 'Show History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: openPanel('history') },
        { label: 'Downloads', accelerator: isMac ? 'Alt+Cmd+L' : 'Ctrl+J', click: openPanel('downloads') },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: inWindow(toggleBookmark) },
        { label: 'Show Bookmarks', accelerator: isMac ? 'Alt+Cmd+B' : 'Ctrl+Shift+O', click: openPanel('bookmarks') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: inWindow((win) => win.activateRelative(1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: inWindow((win) => win.activateRelative(-1)) },
        // Ctrl/Cmd+1 to 8 pick a tab by position; 9 is the last one.
        ...Array.from({ length: 9 }, (_, i): MenuItemConstructorOptions => ({
          label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: inWindow((win) => win.activateIndex(i === 8 ? -1 : i)),
        })),
        ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Privacy Report', click: openPanel('privacy') },
        ...(isMac ? [] : ([{ label: 'About Stillweb', click: openPanel('about') }] as MenuItemConstructorOptions[])),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The toolbar's menu button. */
export function showAppMenu(win: BrowserWin, x: number, y: number): void {
  const tab = win.activeTab;
  const hasPage = !!tab && /^https?:/i.test(tab.url);
  const zoom = tab ? Math.round(tab.contents.getZoomFactor() * 100) : 100;
  const menu = Menu.buildFromTemplate([
    { label: 'New Tab', click: () => win.createTab() },
    { label: 'New Window', click: () => newWindow(false) },
    { label: 'New Private Window', click: () => newWindow(true) },
    { type: 'separator' },
    { label: 'History', click: () => win.send('open-panel', 'history') },
    { label: 'Bookmarks', click: () => win.send('open-panel', 'bookmarks') },
    { label: 'Downloads', click: () => win.send('open-panel', 'downloads') },
    { label: 'Privacy Report', click: () => win.send('open-panel', 'privacy') },
    { type: 'separator' },
    {
      label: `Zoom (${zoom}%)`,
      enabled: hasPage,
      submenu: [
        { label: 'Zoom In', click: () => win.zoom(1) },
        { label: 'Zoom Out', click: () => win.zoom(-1) },
        { label: 'Actual Size', click: () => win.zoom(0) },
      ],
    },
    { label: 'Find in Page…', enabled: hasPage, click: () => win.openFind() },
    { label: 'Print…', enabled: hasPage, click: () => win.print() },
    { type: 'separator' },
    { label: 'Settings', click: () => win.send('open-panel', 'settings') },
    { label: 'About Stillweb', click: () => win.send('open-panel', 'about') },
  ]);
  menu.popup({ window: win.window, x: Math.round(x), y: Math.round(y) });
}

/** Right-click on a tab. */
export function showTabMenu(win: BrowserWin, tabId: number, x: number, y: number): void {
  const tab = win.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const menu = Menu.buildFromTemplate([
    { label: 'New Tab', click: () => win.createTab({ afterId: tabId }) },
    { type: 'separator' },
    { label: 'Reload', enabled: !!tab.url, click: () => tab.contents.reload() },
    { label: 'Duplicate', enabled: !!tab.url, click: () => win.createTab({ url: tab.url, afterId: tabId }) },
    { label: tab.contents.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => win.toggleMute(tabId) },
    { type: 'separator' },
    { label: 'Close Tab', click: () => win.closeTab(tabId) },
    { label: 'Close Other Tabs', enabled: win.tabs.length > 1, click: () => win.closeOtherTabs(tabId) },
    { label: 'Reopen Closed Tab', click: () => win.reopenClosedTab() },
  ]);
  menu.popup({ window: win.window, x: Math.round(x), y: Math.round(y) });
}

/** Right-click in a page. */
export function showPageMenu(win: BrowserWin, tabId: number, params: ContextMenuParams): void {
  const tab = win.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const contents = tab.contents;
  const items: MenuItemConstructorOptions[] = [];
  const separator = () => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
  };
  const link = /^https?:/i.test(params.linkURL) ? params.linkURL : '';

  if (link) {
    items.push(
      { label: 'Open Link in New Tab', click: () => win.createTab({ url: link, activate: false, afterId: tabId }) },
      { label: 'Open Link in New Window', click: () => newWindow(win.isPrivate, link) },
      ...(win.isPrivate ? [] : [{ label: 'Open Link in Private Window', click: () => newWindow(true, link) }]),
      { label: 'Copy Link Address', click: () => clipboard.writeText(link) },
    );
  } else if (params.linkURL) {
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    separator();
    if (/^https?:/i.test(params.srcURL)) {
      items.push(
        { label: 'Open Image in New Tab', click: () => win.createTab({ url: params.srcURL, afterId: tabId }) },
        { label: 'Save Image', click: () => contents.downloadURL(params.srcURL) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      );
    }
    items.push({ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) });
  }
  if ((params.mediaType === 'video' || params.mediaType === 'audio') && /^https?:/i.test(params.srcURL)) {
    separator();
    items.push(
      { label: params.mediaType === 'video' ? 'Open Video in New Tab' : 'Open Audio in New Tab', click: () => win.createTab({ url: params.srcURL, afterId: tabId }) },
      { label: 'Copy Media Address', click: () => clipboard.writeText(params.srcURL) },
    );
  }

  if (params.isEditable) {
    separator();
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    separator();
    items.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    separator();
    const text = params.selectionText.trim();
    const shown = text.length > 30 ? `${text.slice(0, 30)}…` : text;
    const settings = getSettings();
    items.push(
      { role: 'copy' },
      {
        label: `Search for “${shown}”`,
        click: () => win.createTab({ url: searchUrl(text, settings.searchEngine, settings.customSearchTemplate), afterId: tabId }),
      },
    );
  }

  if (!link && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
    items.push(
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Print…', click: () => contents.print() },
    );
  }

  separator();
  items.push({ label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(items).popup({ window: win.window });
}
