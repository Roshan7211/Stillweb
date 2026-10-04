import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Dimensions,
  Keyboard,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShieldEngine, type ShieldWebViewRef } from '../../../native/shield-webview';
import { useLibrary } from '../../browser/library';
import { usePrivacyStatsActions } from '../../browser/privacyStats';
import { readerScript } from '../../browser/reader';
import { useSettings } from '../../browser/settings';
import { useSearchSuggestions } from '../../browser/suggest';
import { useTabs } from '../../browser/tabs';
import { displayHost, isBlank, resolveInput, SEARCH_ENGINES, searchUrl } from '../../browser/url';
import AddressBar from '../components/AddressBar';
import BrowserTabView from '../components/BrowserTabView';
import ContextMenuSheet, { type ContextAction, type ContextTarget } from '../components/ContextMenuSheet';
import MenuSheet, { type MenuAction } from '../components/MenuSheet';
import { Icon, IconButton } from '../components/primitives';
import ShieldPanel from '../components/ShieldPanel';
import SuggestionsPanel from '../components/SuggestionsPanel';
import { useTheme } from '../theme';
import AboutScreen from './AboutScreen';
import PlusScreen from './PlusScreen';
import PrivacyReportScreen from './PrivacyReportScreen';
import { BookmarksScreen, DownloadsScreen, HistoryScreen } from './LibraryScreens';
import SettingsScreen from './SettingsScreen';
import ShieldTestScreen from './ShieldTestScreen';
import TabSwitcherScreen from './TabSwitcherScreen';

type Overlay = 'none' | 'tabs' | 'bookmarks' | 'history' | 'downloads' | 'settings' | 'about' | 'shieldTest' | 'report' | 'plus';

export default function BrowserScreen() {
  const { settings } = useSettings();
  const theme = useTheme(settings.theme);
  const insets = useSafeAreaInsets();
  const tabsApi = useTabs();
  const { tabs, activeTab, liveIds, restored, openTab, closeTab, closeAll, navigate, updateTab } = tabsApi;
  const library = useLibrary();
  const stats = usePrivacyStatsActions();

  const refs = useRef(new Map<string, ShieldWebViewRef>());
  const [overlay, setOverlay] = useState<Overlay>('none');
  // Where the privacy report and Plus screens go back to (they open from several places).
  const [reportBack, setReportBack] = useState<Overlay>('none');
  const [plusBack, setPlusBack] = useState<Overlay>('none');
  const openReport = useCallback((from: Overlay = 'none') => {
    setReportBack(from);
    setOverlay('report');
  }, []);
  const openPlus = (from: Overlay) => {
    setPlusBack(from);
    setOverlay('plus');
  };
  // From the new tab page (stable: tab views are memoized).
  const openReportFromPage = useCallback(() => openReport('none'), [openReport]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [addressText, setAddressText] = useState('');
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [totalBlocked, setTotalBlocked] = useState(0);
  const [privateUnlocked, setPrivateUnlocked] = useState(false);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [fullscreenTabId, setFullscreenTabId] = useState<string | null>(null);
  const contentAspect = useRef(0.6);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Tagged with its tab: only the active tab's result is shown.
  const [findResult, setFindResult] = useState<{ tabId: string; active: number; count: number } | null>(null);
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
    // On iOS the bars move with the keyboard's own animation.
    const follow = (e: KeyboardEvent) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({ duration: e.duration || 250, update: { type: LayoutAnimation.Types.keyboard } });
      }
    };
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => {
      follow(e);
      // Measure from the keyboard's top edge: its reported height leaves out the navigation bar.
      setKeyboardHeight(Math.max(e.endCoordinates.height, Dimensions.get('window').height - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', (e) => {
      follow(e);
      setKeyboardHeight(0);
    });
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

  // Re-lock private tabs whenever the app goes to the background. ('inactive' is iOS's
  // passing state for Control Center, notifications and the Face ID prompt itself.)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') setPrivateUnlocked(false);
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
    // Give web views a moment to be destroyed so the private profile can be deleted, and
    // keep it if a new private tab was opened in the meantime.
    setTimeout(() => {
      if (!tabsRef.current.some((t) => t.incognito)) ShieldEngine.clearPrivateData().catch(() => {});
    }, 600);
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
        // From a private tab, the new tab is private too.
        openTab(target.link, { openerId, activate: false, incognito: target.incognito });
        return showToast(target.incognito ? 'Opened in a new private tab' : 'Opened in a new tab');
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

  // Safari-style shrinking bars while scrolling down a page (iOS).
  const [chromeCollapsed, setChromeCollapsed] = useState(false);
  const onChromeChange = useCallback((collapsed: boolean) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    setChromeCollapsed(collapsed);
  }, []);

  // Leaving a tab: keep its snapshot current and close per-page tools.
  const previousActive = useRef<string | null>(null);
  useEffect(() => {
    const prev = previousActive.current;
    previousActive.current = activeTab?.id ?? null;
    if (prev && prev !== activeTab?.id) captureThumbnail(prev);
    setFindOpen(false);
    setChromeCollapsed(false);
  }, [activeTab?.id, captureThumbnail]);

  const registerRef = useCallback((id: string, ref: ShieldWebViewRef | null) => {
    if (ref) refs.current.set(id, ref);
    else refs.current.delete(id);
  }, []);

  // Stable, so tab views (memoized) don't re-render when another tab changes.
  const onFullscreenChange = useCallback((tabId: string, fullscreen: boolean) => setFullscreenTabId(fullscreen ? tabId : null), []);
  const onFindResult = useCallback((tabId: string, active: number, count: number) => setFindResult({ tabId, active, count }), []);

  // The iOS link menu runs the latest onContextAction through a stable callback, so the
  // memoized tab views don't all re-render with every change here. The ref is only read
  // when the menu is used, never while rendering.
  const contextActionRef = useRef(onContextAction);
  useEffect(() => {
    contextActionRef.current = onContextAction;
  });
  const onLinkAction = useCallback(
    (target: ContextTarget, action: 'open' | 'openPrivate') => contextActionRef.current(action, target),
    [],
  );

  /** Swiping the address bar moves between tabs (in the same mode), like Safari. */
  const switchTab = (direction: 'next' | 'previous') => {
    if (!activeTab) return;
    const same = tabs.filter((t) => t.incognito === activeTab.incognito);
    const target = same[same.findIndex((t) => t.id === activeTab.id) + (direction === 'next' ? 1 : -1)];
    if (target) tabsApi.activate(target.id);
    // Past the last tab: a new one, unless this already is an empty new tab.
    else if (direction === 'next' && !isBlank(activeTab.url)) newTab(activeTab.incognito);
  };

  const startEditing = (initialText = activeTab && !isBlank(activeTab.url) ? activeTab.url : '') => {
    setAddressText(initialText);
    setEditing(true);
  };

  const openFromAddressBar = (url: string) => {
    Keyboard.dismiss();
    if (activeTab && url) navigate(activeTab.id, url);
  };
  const submitAddress = (text: string) => openFromAddressBar(resolveInput(text, settings.searchEngine, settings.customSearchTemplate));
  const searchFor = (text: string) => openFromAddressBar(searchUrl(text, settings.searchEngine, settings.customSearchTemplate));

  // Suggestions for what is typed (nothing while the field still shows the page address).
  const addressQuery = editing && addressText !== activeTab?.url ? addressText.trim() : '';
  const siteSuggestions = useMemo(
    () => (addressQuery ? library.suggest(addressQuery, 4).filter((s) => !incognito || s.kind === 'bookmark') : []),
    [addressQuery, library, incognito],
  );
  // Private tabs never send what is typed to the search engine.
  const remoteSuggestions = useSearchSuggestions(addressQuery, settings.searchEngine, settings.searchSuggestions && !incognito);
  const engineLabel = SEARCH_ENGINES.find((e) => e.id === settings.searchEngine)?.label ?? '';

  const openInCurrent = (url: string) => {
    setOverlay('none');
    if (activeTab && !privateLocked) navigate(activeTab.id, url);
    else openTab(url);
  };

  const newTab = async (asPrivate: boolean) => {
    if (asPrivate && !(await unlockPrivate())) return;
    openTab('', { incognito: asPrivate });
    startEditing('');
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
        setOverlay(
          overlay === 'about' || overlay === 'shieldTest'
            ? 'settings'
            : overlay === 'report'
              ? reportBack
              : overlay === 'plus'
                ? plusBack
                : 'none',
        );
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
      stats.clear();
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
      case 'find': {
        const ref = activeRef();
        // iOS: Safari's own find bar (with match counts), once the menu sheet has closed.
        setTimeout(async () => {
          if (Platform.OS === 'ios' && (await ref?.showFindNavigator().catch(() => false))) return;
          setFindQuery('');
          setFindResult(null);
          setFindOpen(true);
        }, Platform.OS === 'ios' ? 350 : 0);
        return;
      }
      case 'share':
        return Share.share(Platform.OS === 'ios' ? { url } : { message: url });
      case 'quit':
        return quit();
    }
  };

  const bottomBar = settings.addressBarPosition === 'bottom';
  // iOS web views scroll their own fields above the keyboard, so the browser isn't lifted for
  // them: that would leave a gap and resize the page (and any video in it). Only the find bar
  // is lifted there, and a bottom address bar slides up on its own (barShift) without
  // resizing the page underneath. Android lifts everything, as the window doesn't resize.
  const keyboardLift = Platform.OS === 'ios' && !findOpen ? 0 : keyboardHeight;
  const showToolbar = Platform.OS === 'ios' ? keyboardLift === 0 : !editing && keyboardHeight === 0;
  // Part of the page area hidden by the keyboard on iOS (it sits over the toolbar first).
  const keyboardOverPage = Platform.OS === 'ios' ? Math.max(0, keyboardHeight - (showToolbar ? toolbarHeight : 0)) : 0;
  const barShift = bottomBar && editing ? keyboardOverPage : 0;

  const chrome = incognito ? theme.privateBackground : theme.background;
  const fg = incognito ? '#ECE6F7' : theme.text;
  const normalCount = tabs.filter((t) => !t.incognito).length;
  const privateCount = tabs.length - normalCount;
  const tabCount = incognito ? privateCount : normalCount;
  const hasPage = !!activeTab && !isBlank(activeTab.url) && !(incognito && privateLocked);
  // A locked private tab doesn't reveal where it is.
  const visibleUrl = incognito && privateLocked ? '' : (activeTab?.url ?? '');
  const muted = incognito ? '#B3A8CC' : theme.muted;
  // Shrunk bars give way whenever the browser chrome is needed.
  const collapsed = chromeCollapsed && hasPage && !editing && !findOpen && keyboardHeight === 0 && overlay === 'none';

  const addressBar = (
    <AddressBar
      theme={theme}
      url={visibleUrl}
      incognito={incognito}
      loading={activeTab?.loading ?? false}
      progress={activeTab?.progress ?? 0}
      secure={activeTab?.secure ?? false}
      shieldsActive={activeTab?.shieldsActive ?? settings.shields.enabled}
      blocked={activeTab?.blocked ?? 0}
      position={bottomBar ? 'bottom' : 'top'}
      editing={editing}
      text={addressText}
      onChangeText={setAddressText}
      onStartEditing={() => (incognito && privateLocked ? unlockPrivate() : startEditing())}
      onEndEditing={() => setEditing(false)}
      onSubmit={submitAddress}
      onShieldPress={() => setShieldOpen(true)}
      onReload={() => activeRef()?.reload()}
      onStop={() => activeRef()?.stopLoading()}
      onSwipe={switchTab}
    />
  );

  // Safari's minimized bar: just the site; tapping it brings the bars back.
  const compactBar = (
    <Pressable
      style={styles.compact}
      onPress={() => onChromeChange(false)}
      accessibilityRole="button"
      accessibilityLabel={`${displayHost(activeTab?.url ?? '')}, show toolbar`}>
      {activeTab?.secure ? <Icon name="lock" size={10} color={muted} /> : null}
      <Text style={[styles.compactText, { color: fg }]} numberOfLines={1}>
        {displayHost(activeTab?.url ?? '')}
      </Text>
    </Pressable>
  );

  return (
    // Left/right insets keep content clear of the navigation bar and cut-outs in landscape.
    <View
      style={[
        styles.root,
        { backgroundColor: chrome, paddingBottom: keyboardLift, paddingLeft: insets.left, paddingRight: insets.right },
      ]}>
      <StatusBar style={incognito || theme.dark ? 'light' : 'dark'} />
      <View style={{ paddingTop: insets.top, backgroundColor: chrome, zIndex: 10 }}>
        {bottomBar ? null : collapsed ? compactBar : addressBar}
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
              onFullscreenChange={onFullscreenChange}
              onFindResult={onFindResult}
              onLinkAction={onLinkAction}
              onChromeChange={onChromeChange}
              onOpenReport={openReportFromPage}
              chromeCollapsed={tab.id === activeTab?.id && collapsed}
            />
          ))}
        {incognito && privateLocked ? (
          <Pressable style={[StyleSheet.absoluteFill, styles.locked, { backgroundColor: theme.privateBackground }]} onPress={unlockPrivate}>
            <Icon name="lock" size={36} color="#ECE6F7" />
            <Text style={styles.lockedTitle}>Private tabs are locked</Text>
            <Text style={{ color: '#B3A8CC' }}>Tap to unlock</Text>
          </Pressable>
        ) : null}
        {/* The new tab page stays usable while typing; a page gets covered, like Safari. */}
        {editing && (addressQuery || !isBlank(activeTab?.url)) ? (
          <SuggestionsPanel
            theme={theme}
            incognito={incognito}
            query={addressQuery}
            sites={siteSuggestions}
            remote={remoteSuggestions}
            engineLabel={settings.searchEngine === 'custom' ? '' : engineLabel}
            bottomInset={keyboardOverPage}
            onOpen={(url) => openFromAddressBar(resolveInput(url, settings.searchEngine, settings.customSearchTemplate))}
            onSearch={searchFor}
            onFill={setAddressText}
          />
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
          {findQuery && findResult && findResult.tabId === activeTab?.id ? (
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

      {/* Safari-style bottom bar: the address above the toolbar, in thumb reach. The find bar
          takes its place while open. */}
      {bottomBar && !findOpen && collapsed ? (
        <View style={[styles.compactBottom, { paddingBottom: insets.bottom, backgroundColor: chrome }]}>{compactBar}</View>
      ) : null}
      {/* Top bar layout, shrunk: the page reaches the bottom edge, clear of the home indicator. */}
      {!bottomBar && collapsed ? <View style={{ height: insets.bottom, backgroundColor: chrome }} /> : null}

      {bottomBar && !findOpen && !collapsed ? (
        <View style={[styles.bottomBar, { top: -barShift, backgroundColor: chrome, borderColor: incognito ? theme.privateSurface : theme.border }]}>
          {addressBar}
        </View>
      ) : null}

      {showToolbar && !collapsed ? (
        <View
          onLayout={(e) => setToolbarHeight(e.nativeEvent.layout.height)}
          // Safari hides the toolbar while the address is edited; on iOS it stays laid out so
          // the page keeps its size.
          pointerEvents={editing ? 'none' : 'auto'}
          style={[
            styles.toolbar,
            !bottomBar && styles.toolbarBorder,
            { backgroundColor: chrome, paddingBottom: insets.bottom, borderColor: incognito ? theme.privateSurface : theme.border },
            editing && styles.toolbarHidden,
          ]}>
          <IconButton
            name={Platform.OS === 'ios' ? 'chevron-left' : 'arrow-left'}
            label="Back"
            color={fg}
            size={Platform.OS === 'ios' ? 26 : 22}
            disabled={!activeTab || (!activeTab.canGoBack && !activeTab.reader && !activeTab.openerId)}
            onPress={goBack}
          />
          <IconButton
            name={Platform.OS === 'ios' ? 'chevron-right' : 'arrow-right'}
            label="Forward"
            color={fg}
            size={Platform.OS === 'ios' ? 26 : 22}
            disabled={!activeTab?.canGoForward}
            onPress={() => activeRef()?.goForward()}
          />
          {Platform.OS === 'ios' ? (
            <IconButton name="share" label="Share" color={fg} disabled={!hasPage} onPress={() => onMenu('share')} />
          ) : (
            <IconButton name="plus" label="New tab" color={fg} onPress={() => newTab(incognito)} />
          )}
          <IconButton
            name="square"
            label={`${tabCount} tabs`}
            color={fg}
            badge={String(Math.min(tabCount, 99))}
            onPress={openTabSwitcher}
          />
          <IconButton
            name={Platform.OS === 'ios' ? 'more-horizontal' : 'more-vertical'}
            label="Menu"
            color={fg}
            onPress={() => setMenuOpen(true)}
          />
        </View>
      ) : null}

      <MenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        theme={theme}
        hasPage={hasPage}
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
        url={visibleUrl}
        blocked={activeTab?.blocked ?? 0}
        totalBlocked={totalBlocked}
        onChanged={() => setTimeout(() => activeRef()?.reload(), 50)}
        onOpenSettings={() => {
          setShieldOpen(false);
          setOverlay('settings');
        }}
        onOpenReport={() => {
          setShieldOpen(false);
          openReport('none');
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
              onOpenPlus={() => openPlus('settings')}
              onOpenReport={() => openReport('settings')}
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
          ) : overlay === 'report' ? (
            <PrivacyReportScreen theme={theme} onBack={() => setOverlay(reportBack)} onUpgrade={() => openPlus('report')} />
          ) : overlay === 'plus' ? (
            <PlusScreen
              theme={theme}
              onBack={() => setOverlay(plusBack)}
              onOpen={(url) => {
                setOverlay('none');
                openTab(url);
              }}
            />
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
    paddingTop: 2,
  },
  toolbarBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  toolbarHidden: { opacity: 0 },
  bottomBar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, zIndex: 10 },
  compact: { height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 16 },
  compactText: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
  compactBottom: { paddingTop: 2 },
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
