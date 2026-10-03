import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Dimensions, Keyboard, Linking, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShieldEngine, type ShieldWebViewRef } from '../../../native/shield-webview';
import { useLibrary } from '../../browser/library';
import { readerScript } from '../../browser/reader';
import { useSettings } from '../../browser/settings';
import { useTabs } from '../../browser/tabs';
import { isBlank, resolveInput } from '../../browser/url';
import AddressBar from '../components/AddressBar';
import BrowserTabView from '../components/BrowserTabView';
import ContextMenuSheet, { type ContextAction, type ContextTarget } from '../components/ContextMenuSheet';
import MenuSheet, { type MenuAction } from '../components/MenuSheet';
import { Icon, IconButton } from '../components/primitives';
import ShieldPanel from '../components/ShieldPanel';
import { useTheme } from '../theme';
import AboutScreen from './AboutScreen';
import { BookmarksScreen, DownloadsScreen, HistoryScreen } from './LibraryScreens';
import SettingsScreen from './SettingsScreen';
import ShieldTestScreen from './ShieldTestScreen';
import TabSwitcherScreen from './TabSwitcherScreen';

type Overlay = 'none' | 'tabs' | 'bookmarks' | 'history' | 'downloads' | 'settings' | 'about' | 'shieldTest';

export default function BrowserScreen() {
  const { settings } = useSettings();
  const theme = useTheme(settings.theme);
  const insets = useSafeAreaInsets();
  const tabsApi = useTabs();
  const { tabs, activeTab, liveIds, restored, openTab, closeTab, closeAll, navigate, updateTab } = tabsApi;
  const library = useLibrary();

  const refs = useRef(new Map<string, ShieldWebViewRef>());
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [menuOpen, setMenuOpen] = useState(false);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [addressFocused, setAddressFocused] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [totalBlocked, setTotalBlocked] = useState(0);
  const [privateUnlocked, setPrivateUnlocked] = useState(false);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [fullscreenTabId, setFullscreenTabId] = useState<string | null>(null);
  const contentAspect = useRef(0.6);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [findResult, setFindResult] = useState<{ active: number; count: number } | null>(null);
  const findInput = useRef<TextInput>(null);
  // Focus once the menu sheet has finished closing; autoFocus loses that race on Android.
  useEffect(() => {
    if (!findOpen) return;
    const timer = setTimeout(() => findInput.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [findOpen]);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // The app draws edge-to-edge, so the system no longer shrinks the window for the
  // keyboard. Lift the whole browser instead, so page inputs and the find bar stay visible.
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      // Measure from the keyboard's top edge: its reported height leaves out the navigation bar.
      setKeyboardHeight(Math.max(e.endCoordinates.height, Dimensions.get('window').height - e.endCoordinates.screenY)),
    );
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const incognito = activeTab?.incognito ?? false;
  const privateLocked = settings.lockPrivateTabs && !privateUnlocked;
  const activeRef = () => (activeTab ? refs.current.get(activeTab.id) : undefined);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => {
    ShieldEngine.getStatus().then((s) => setTotalBlocked(s.totalBlocked));
  }, []);

  // Re-lock private tabs whenever the app leaves the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') setPrivateUnlocked(false);
    });
    return () => sub.remove();
  }, []);

  const unlockPrivate = useCallback(async (): Promise<boolean> => {
    if (!settings.lockPrivateTabs || privateUnlocked) return true;
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock private tabs' });
    if (result.success) setPrivateUnlocked(true);
    return result.success;
  }, [settings.lockPrivateTabs, privateUnlocked]);

  const onPrivateTabsGone = useCallback(() => {
    // Give web views a moment to be destroyed so the private profile can be deleted.
    setTimeout(() => ShieldEngine.clearPrivateData().catch(() => {}), 600);
  }, []);

  // While any private tab exists, keep the window out of screenshots and the app switcher.
  const hasPrivateTabs = tabs.some((t) => t.incognito);
  useEffect(() => {
    ShieldEngine.setSecureWindow(hasPrivateTabs).catch(() => {});
  }, [hasPrivateTabs]);

  // Links opened from other apps (when this is the default browser) get a new tab.
  useEffect(() => {
    if (!restored) return;
    const open = (url: string | null) => {
      if (url && /^https?:\/\//i.test(url)) {
        setOverlay('none');
        openTab(url);
      }
    };
    Linking.getInitialURL().then(open).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, [restored, openTab]);

  const onContextAction = async (action: ContextAction, target: ContextTarget) => {
    const openerId = activeTab?.id;
    switch (action) {
      case 'open':
        openTab(target.link, { openerId, activate: false });
        return showToast('Opened in a new tab');
      case 'openPrivate':
        if (!(await unlockPrivate())) return;
        openTab(target.link, { incognito: true });
        return;
      case 'copy':
        await Clipboard.setStringAsync(target.link);
        return showToast('Link copied');
      case 'share':
        return Share.share({ message: target.link });
      case 'openImage':
        openTab(target.image, { incognito: target.incognito, openerId });
        return;
      case 'downloadImage':
        try {
          const result = await ShieldEngine.startDownload({ url: target.image, incognito: target.incognito });
          if (!target.incognito) library.addDownload({ url: target.image, fileName: result.fileName, nativeId: result.id });
          showToast(`Downloading ${result.fileName}`);
        } catch {
          showToast('Download failed');
        }
    }
  };

  /** Snapshot a tab's page for the tab switcher (quietly does nothing for new-tab pages). */
  const captureThumbnail = useCallback(
    async (tabId: string) => {
      const ref = refs.current.get(tabId);
      // Private pages are never written to disk, not even as a temporary snapshot.
      if (!ref || tabsRef.current.find((t) => t.id === tabId)?.incognito) return;
      try {
        const uri = await ref.captureThumbnail(tabId);
        if (uri) updateTab(tabId, { thumbnail: `${uri}?t=${Date.now()}`, thumbAspect: contentAspect.current });
      } catch {}
    },
    [updateTab],
  );

  const openTabSwitcher = async () => {
    if (activeTab) await captureThumbnail(activeTab.id);
    setOverlay('tabs');
  };

  // Leaving a tab: keep its snapshot current and close per-page tools.
  const previousActive = useRef<string | null>(null);
  useEffect(() => {
    const prev = previousActive.current;
    previousActive.current = activeTab?.id ?? null;
    if (prev && prev !== activeTab?.id) captureThumbnail(prev);
    setFindOpen(false);
  }, [activeTab?.id, captureThumbnail]);

  const registerRef = useCallback((id: string, ref: ShieldWebViewRef | null) => {
    if (ref) refs.current.set(id, ref);
    else refs.current.delete(id);
  }, []);

  const submitAddress = (text: string) => {
    if (!activeTab) return;
    const url = resolveInput(text, settings.searchEngine, settings.customSearchTemplate);
    if (url) navigate(activeTab.id, url);
  };

  const openInCurrent = (url: string) => {
    setOverlay('none');
    if (activeTab && !privateLocked) navigate(activeTab.id, url);
    else openTab(url);
  };

  const newTab = async (asPrivate: boolean) => {
    if (asPrivate && !(await unlockPrivate())) return;
    openTab('', { incognito: asPrivate });
    setFocusKey((k) => k + 1);
  };

  const closeActiveTab = () => {
    if (!activeTab) return;
    const wasPrivate = activeTab.incognito;
    const remainingPrivate = tabs.filter((t) => t.incognito && t.id !== activeTab.id).length;
    closeTab(activeTab.id);
    if (wasPrivate && remainingPrivate === 0) onPrivateTabsGone();
    if (tabs.length <= 1) openTab('');
  };

  const goBack = () => {
    if (!activeTab) return;
    if (activeTab.reader) {
      activeRef()?.reload();
    } else if (activeTab.canGoBack) {
      activeRef()?.goBack();
    } else if (activeTab.openerId && tabs.some((t) => t.id === activeTab.openerId)) {
      closeActiveTab();
    }
  };

  // Android hardware back.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fullscreenTabId) {
        refs.current.get(fullscreenTabId)?.exitFullscreen();
        setFullscreenTabId(null);
        return true;
      }
      if (menuOpen || shieldOpen || contextTarget) {
        setMenuOpen(false);
        setShieldOpen(false);
        setContextTarget(null);
        return true;
      }
      if (overlay !== 'none') {
        setOverlay(overlay === 'about' ? 'settings' : 'none');
        return true;
      }
      if (findOpen) {
        setFindOpen(false);
        activeRef()?.clearFind();
        return true;
      }
      if (activeTab && (activeTab.canGoBack || activeTab.reader || activeTab.openerId)) {
        goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  });

  const toggleReader = async () => {
    if (!activeTab) return;
    if (activeTab.reader) {
      updateTab(activeTab.id, { reader: false });
      activeRef()?.reload();
      return;
    }
    const result = await activeRef()?.evaluateJavaScript(readerScript(theme));
    if (result === 'true') updateTab(activeTab.id, { reader: true });
    else showToast("Reader view isn't available for this page");
  };

  const quit = async () => {
    if (settings.clearDataOnExit) {
      await ShieldEngine.clearBrowsingData().catch(() => {});
      library.clearHistory();
      closeAll(true);
      closeAll(false);
    }
    BackHandler.exitApp();
  };

  const onMenu = async (action: MenuAction) => {
    setMenuOpen(false);
    const url = activeTab?.url ?? '';
    switch (action) {
      case 'newTab':
        return newTab(false);
      case 'newPrivateTab':
        return newTab(true);
      case 'bookmarks':
      case 'history':
      case 'downloads':
      case 'settings':
        return setOverlay(action);
      case 'toggleBookmark':
        library.toggleBookmark(url, activeTab?.title ?? url);
        return showToast(library.isBookmarked(url) ? 'Bookmark removed' : 'Bookmarked');
      case 'reader':
        return toggleReader();
      case 'find':
        setFindQuery('');
        setFindResult(null);
        return setFindOpen(true);
      case 'share':
        return Share.share(Platform.OS === 'ios' ? { url } : { message: url });
      case 'quit':
        return quit();
    }
  };

  const chrome = incognito ? theme.privateBackground : theme.background;
  const fg = incognito ? '#ECE6F7' : theme.text;
  const normalCount = tabs.filter((t) => !t.incognito).length;
  const privateCount = tabs.length - normalCount;
  const tabCount = incognito ? privateCount : normalCount;

  return (
    // Left/right insets keep content clear of the navigation bar and cut-outs in landscape.
    <View
      style={[
        styles.root,
        { backgroundColor: chrome, paddingBottom: keyboardHeight, paddingLeft: insets.left, paddingRight: insets.right },
      ]}>
      <StatusBar style={incognito || theme.dark ? 'light' : 'dark'} />
      <View style={{ paddingTop: insets.top, backgroundColor: chrome, zIndex: 10 }}>
        <AddressBar
          theme={theme}
          url={activeTab?.url ?? ''}
          incognito={incognito}
          loading={activeTab?.loading ?? false}
          progress={activeTab?.progress ?? 0}
          secure={activeTab?.secure ?? false}
          shieldsActive={activeTab?.shieldsActive ?? settings.shields.enabled}
          blocked={activeTab?.blocked ?? 0}
          focusKey={focusKey}
          onSubmit={submitAddress}
          onShieldPress={() => setShieldOpen(true)}
          onReload={() => activeRef()?.reload()}
          onStop={() => activeRef()?.stopLoading()}
          onFocusChange={setAddressFocused}
        />
      </View>

      <View
        style={styles.content}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width && height) contentAspect.current = width / height;
        }}>
        {tabs
          .filter((t) => liveIds.has(t.id))
          .map((tab) => (
            <BrowserTabView
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab?.id}
              theme={theme}
              totalBlocked={totalBlocked}
              onTotalBlocked={setTotalBlocked}
              registerRef={registerRef}
              onToast={showToast}
              onContextMenu={setContextTarget}
              onFullscreenChange={(fullscreen) => setFullscreenTabId(fullscreen ? tab.id : null)}
              onFindResult={(active, count) => tab.id === activeTab?.id && setFindResult({ active, count })}
            />
          ))}
        {incognito && privateLocked ? (
          <Pressable style={[StyleSheet.absoluteFill, styles.locked, { backgroundColor: theme.privateBackground }]} onPress={unlockPrivate}>
            <Icon name="lock" size={36} color="#ECE6F7" />
            <Text style={styles.lockedTitle}>Private tabs are locked</Text>
            <Text style={{ color: '#B3A8CC' }}>Tap to unlock</Text>
          </Pressable>
        ) : null}
        {toast ? (
          <View style={[styles.toast, { backgroundColor: theme.dark ? '#ECEDEF' : '#25272B' }]} pointerEvents="none">
            <Text style={{ color: theme.dark ? '#16171A' : '#FFFFFF' }}>{toast}</Text>
          </View>
        ) : null}
      </View>

      {findOpen ? (
        <View style={[styles.findBar, { backgroundColor: chrome, borderColor: theme.border }]}>
          <TextInput
            ref={findInput}
            style={[styles.findInput, { color: fg }]}
            value={findQuery}
            onChangeText={(q) => {
              setFindQuery(q);
              if (!q) setFindResult(null);
              activeRef()?.findInPage(q);
            }}
            placeholder="Find in page"
            placeholderTextColor={theme.muted}
            returnKeyType="search"
            onSubmitEditing={() => activeRef()?.findNext(true)}
          />
          {findQuery && findResult ? (
            <Text style={[styles.findCount, { color: theme.muted }]}>
              {findResult.count === 0 ? 'No matches' : findResult.count > 0 ? `${findResult.active} of ${findResult.count}` : ''}
            </Text>
          ) : null}
          <IconButton name="chevron-up" label="Previous match" color={fg} onPress={() => activeRef()?.findNext(false)} />
          <IconButton name="chevron-down" label="Next match" color={fg} onPress={() => activeRef()?.findNext(true)} />
          <IconButton
            name="x"
            label="Close find"
            color={fg}
            onPress={() => {
              setFindOpen(false);
              activeRef()?.clearFind();
            }}
          />
        </View>
      ) : null}

      {!addressFocused && keyboardHeight === 0 ? (
        <View style={[styles.toolbar, { backgroundColor: chrome, paddingBottom: insets.bottom, borderColor: incognito ? theme.privateSurface : theme.border }]}>
          <IconButton
            name="arrow-left"
            label="Back"
            color={fg}
            disabled={!activeTab || (!activeTab.canGoBack && !activeTab.reader && !activeTab.openerId)}
            onPress={goBack}
          />
          <IconButton name="arrow-right" label="Forward" color={fg} disabled={!activeTab?.canGoForward} onPress={() => activeRef()?.goForward()} />
          <IconButton name="plus" label="New tab" color={fg} onPress={() => newTab(incognito)} />
          <IconButton
            name="square"
            label={`${tabCount} tabs`}
            color={fg}
            badge={String(Math.min(tabCount, 99))}
            onPress={openTabSwitcher}
          />
          <IconButton name="more-vertical" label="Menu" color={fg} onPress={() => setMenuOpen(true)} />
        </View>
      ) : null}

      <MenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        theme={theme}
        hasPage={!!activeTab && !isBlank(activeTab.url) && !(incognito && privateLocked)}
        bookmarked={!!activeTab && library.isBookmarked(activeTab.url)}
        readerActive={!!activeTab?.reader}
        showQuit={Platform.OS === 'android'}
        clearsOnQuit={settings.clearDataOnExit}
        onAction={onMenu}
      />
      <ContextMenuSheet target={contextTarget} theme={theme} onClose={() => setContextTarget(null)} onAction={onContextAction} />
      <ShieldPanel
        visible={shieldOpen}
        onClose={() => setShieldOpen(false)}
        theme={theme}
        url={activeTab?.url ?? ''}
        blocked={activeTab?.blocked ?? 0}
        totalBlocked={totalBlocked}
        onChanged={() => setTimeout(() => activeRef()?.reload(), 50)}
        onOpenSettings={() => {
          setShieldOpen(false);
          setOverlay('settings');
        }}
      />

      {overlay !== 'none' ? (
        <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: theme.background }]}>
          {overlay === 'tabs' ? (
            <TabSwitcherScreen
              theme={theme}
              initialPrivate={incognito}
              privateLocked={privateLocked}
              onUnlock={unlockPrivate}
              onClose={() => {
                setOverlay('none');
                if (!tabsApi.tabs.length) openTab('');
              }}
              onPrivateClosed={onPrivateTabsGone}
              onNewTab={(asPrivate) => {
                setOverlay('none');
                newTab(asPrivate);
              }}
            />
          ) : overlay === 'bookmarks' ? (
            <BookmarksScreen theme={theme} onBack={() => setOverlay('none')} onOpen={openInCurrent} />
          ) : overlay === 'history' ? (
            <HistoryScreen theme={theme} onBack={() => setOverlay('none')} onOpen={openInCurrent} />
          ) : overlay === 'downloads' ? (
            <DownloadsScreen theme={theme} onBack={() => setOverlay('none')} />
          ) : overlay === 'settings' ? (
            <SettingsScreen
              theme={theme}
              onBack={() => setOverlay('none')}
              onOpenAbout={() => setOverlay('about')}
              onOpenShieldTest={() => setOverlay('shieldTest')}
              onClearedData={() => ShieldEngine.getStatus().then((s) => setTotalBlocked(s.totalBlocked))}
            />
          ) : overlay === 'about' ? (
            <AboutScreen
              theme={theme}
              onBack={() => setOverlay('settings')}
              onOpen={(url) => {
                setOverlay('none');
                openTab(url);
              }}
            />
          ) : overlay === 'shieldTest' ? (
            <ShieldTestScreen onClose={() => setOverlay('settings')} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1 },
  // Above the address bar (zIndex 10).
  overlay: { zIndex: 20, elevation: 20 },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 2,
  },
  findBar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingLeft: 14 },
  findInput: { flex: 1, height: 48, fontSize: 16 },
  findCount: { fontSize: 13, marginRight: 4 },
  locked: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  lockedTitle: { color: '#ECE6F7', fontSize: 18, fontWeight: '600' },
  toast: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
});
