import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import { BlurView } from 'expo-blur';
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
import { rateScript, stopAtEndDoneScript, stopAtEndScript, type SleepChoice } from '../../browser/listen';
import { pickerBiggerScript, pickerCancelScript, pickerFinishScript, pickerStartScript } from '../../browser/picker';
import { refreshBlockedTotal } from '../../browser/blockedTotal';
import { pageDarkScript, parsePageDark } from '../../browser/pageTheme';
import { usePrivacyStatsActions } from '../../browser/privacyStats';
import { readerScript, readerThemeScript } from '../../browser/reader';
import { useSettings } from '../../browser/settings';
import { useSearchSuggestions } from '../../browser/suggest';
import { profileName, profileOf, type Profile } from '../../browser/profiles';
import { useTabs } from '../../browser/tabs';
import { usePlus } from '../../plus/plus';
import { displayHost, isBlank, resolveInput, SEARCH_ENGINES, searchUrl, siteKey } from '../../browser/url';
import AddressBar from '../components/AddressBar';
import BrowserTabView from '../components/BrowserTabView';
import ContextMenuSheet, { type ContextAction, type ContextTarget } from '../components/ContextMenuSheet';
import { ErrorBoundary, ProblemScreen } from '../components/ErrorBoundary';
import MenuSheet, { type MenuAction } from '../components/MenuSheet';
import { Icon, IconButton } from '../components/primitives';
import ListenSheet, { type SleepState } from '../components/ListenSheet';
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
import VaultScreen from './VaultScreen';

type Overlay = 'none' | 'tabs' | 'bookmarks' | 'history' | 'downloads' | 'settings' | 'about' | 'shieldTest' | 'report' | 'plus' | 'vault';

const NO_PROFILES: Profile[] = [];

export default function BrowserScreen() {
  const { settings, setSiteFix } = useSettings();
  const plus = usePlus();
  const theme = useTheme(settings.theme, plus.unlocked ? settings.accent : 'blue');
  // Stillweb Plus profiles; without Plus, every normal tab shows together (each keeps its data).
  const profiles = plus.unlocked && ShieldEngine.profilesSupported === true ? settings.profiles : NO_PROFILES;
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
  // Listen Mode (Stillweb Plus).
  const [listenOpen, setListenOpen] = useState(false);
  // The timed sleep timer; "end of this one" is kept on its tab (Tab.stopAtEnd).
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  // "Hide an element" (Stillweb Plus): the page is in picking mode.
  const [picking, setPicking] = useState(false);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [addressText, setAddressText] = useState('');
  const [toolbarHeight, setToolbarHeight] = useState(0);
  // Height of the floating bottom bars (edge-to-edge layout): the page's bottom inset.
  const [barsHeight, setBarsHeight] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
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
    refreshBlockedTotal();
  }, []);

  // The sleep timer runs natively (it must fire in the background) and reports here.
  useEffect(() => {
    const sub = ShieldEngine.addListener('onSleepTimerFired', () => {
      setSleepEndsAt(null);
      showToast('Sleep timer paused playback');
    });
    return () => sub.remove();
  }, [showToast]);

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
    try {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock private tabs' });
      if (result.success) setPrivateUnlocked(true);
      return result.success;
    } catch {
      return false;
    }
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
          const result = await ShieldEngine.startDownload({
            url: target.image,
            incognito: target.incognito,
            profileId: target.incognito ? undefined : activeTab?.profileId,
          });
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
    // A fresh snapshot if it's quick; the switcher never waits long for it (it shows up
    // there as soon as it's ready).
    if (activeTab) await Promise.race([captureThumbnail(activeTab.id), new Promise((resolve) => setTimeout(resolve, 150))]);
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
    setPicking(false);
  }, [activeTab?.id, captureThumbnail]);

  // After a theme change, pages that switch by themselves have new colours: the status bar
  // over them follows (pages that need a reload are re-measured when they finish loading).
  const pagesDark = theme.dark && settings.darkPages;
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const timer = setTimeout(() => {
      refs.current.forEach((ref, id) => {
        ref
          .evaluateJavaScript(pageDarkScript())
          .then((raw) => updateTab(id, { pageDark: parsePageDark(raw) }))
          .catch(() => {});
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [pagesDark, updateTab]);

  // Pages in reader view take the new theme in place.
  useEffect(() => {
    tabsRef.current
      .filter((t) => t.reader)
      .forEach((t) => {
        refs.current.get(t.id)?.evaluateJavaScript(readerThemeScript(theme)).catch(() => {});
        updateTab(t.id, { pageDark: theme.dark });
      });
  }, [theme, updateTab]);

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

  const setPlaybackRate = (rate: number) => {
    if (!activeTab) return;
    updateTab(activeTab.id, { playbackRate: rate });
    activeRef()?.evaluateJavaScript(rateScript(rate)).catch(() => {});
  };

  const stopAtEndTab = tabs.find((t) => t.stopAtEnd);
  const sleep: SleepState = sleepEndsAt
    ? { endsAt: sleepEndsAt }
    : stopAtEndTab
      ? { endOfMedia: true, tabId: stopAtEndTab.id }
      : null;

  const chooseSleep = (choice: SleepChoice | null) => {
    // Whatever was set before ends first.
    Promise.resolve(ShieldEngine.setSleepTimer(null)).catch(() => {});
    setSleepEndsAt(null);
    if (stopAtEndTab) {
      refs.current.get(stopAtEndTab.id)?.evaluateJavaScript(stopAtEndScript('off')).catch(() => {});
      updateTab(stopAtEndTab.id, { stopAtEnd: undefined });
    }
    if (choice?.endOfMedia && activeTab && !isBlank(activeTab.url)) {
      activeRef()?.evaluateJavaScript(stopAtEndScript('start')).catch(() => {});
      updateTab(activeTab.id, { stopAtEnd: siteKey(activeTab.url) });
      showToast('Playback pauses when this one ends');
    } else if (choice?.endOfMedia) {
      showToast('Open a page that plays audio or video first');
    } else if (choice?.minutes) {
      const seconds = choice.minutes * 60;
      Promise.resolve(ShieldEngine.setSleepTimer(seconds)).catch(() => {});
      setSleepEndsAt(Date.now() + seconds * 1000);
      showToast(`Playback pauses in ${choice.label}`);
    }
    if (choice) setListenOpen(false);
  };

  /** Opens Listen; an "end of this one" that has already paused playback is shown as off. */
  const openListen = () => {
    setListenOpen(true);
    if (!stopAtEndTab) return;
    const ref = refs.current.get(stopAtEndTab.id);
    const clear = () => updateTab(stopAtEndTab.id, { stopAtEnd: undefined });
    // A tab whose page was unloaded has nothing left to pause.
    if (!ref) return clear();
    ref
      .evaluateJavaScript(stopAtEndDoneScript())
      .then((done) => done === 'true' && clear())
      .catch(() => {});
  };

  const startPicking = () => {
    const ref = activeRef();
    if (!ref) return;
    ref
      .evaluateJavaScript(pickerStartScript())
      .then((result) => (result === 'true' ? setPicking(true) : showToast('This page can’t be changed')))
      .catch(() => showToast('This page can’t be changed'));
  };

  const finishPicking = async () => {
    const site = activeTab ? siteKey(activeTab.url) : '';
    let selector: string | null = null;
    try {
      const raw = await activeRef()?.evaluateJavaScript(pickerFinishScript());
      selector = raw ? (JSON.parse(raw) as string | null) : null;
    } catch {
      selector = null;
    }
    if (!selector) return showToast('Tap something on the page first');
    setPicking(false);
    if (!site) return;
    const hidden = settings.siteFixes[site]?.hidden ?? [];
    if (!hidden.includes(selector)) setSiteFix(site, { hidden: [...hidden, selector] });
    showToast(`Hidden on ${site}. Undo it from the shield.`);
  };

  const cancelPicking = () => {
    activeRef()?.evaluateJavaScript(pickerCancelScript()).catch(() => {});
    setPicking(false);
  };

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

  const newTab = async (asPrivate: boolean, profileId?: string | null) => {
    if (asPrivate && !(await unlockPrivate())) return;
    openTab('', { incognito: asPrivate, profileId });
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
    const result = await activeRef()
      ?.evaluateJavaScript(readerScript(theme))
      .catch(() => null);
    if (result === 'true') {
      // Reader view draws the article in the app's theme.
      updateTab(activeTab.id, { reader: true, pageDark: theme.dark });
    } else {
      showToast("Reader view isn't available for this page");
    }
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
    // iOS shows one sheet at a time: what opens from the menu waits until it has closed.
    const afterMenu = Platform.OS === 'ios' && menuOpen ? 350 : 0;
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
      case 'toggleBookmark': {
        // From a private tab, with the vault on, bookmarks go to the locked vault.
        const toVault = incognito && settings.vault && plus.unlocked;
        const removing = library.isBookmarked(url);
        library.toggleBookmark(url, activeTab?.title ?? url, toVault);
        return showToast(removing ? 'Bookmark removed' : toVault ? 'Saved to your vault' : 'Bookmarked');
      }
      case 'vault':
        if (!plus.unlocked) return openPlus('none');
        return setOverlay('vault');
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
      case 'desktop': {
        const site = siteKey(url);
        if (!site) return;
        const desktop = !settings.siteFixes[site]?.desktop;
        setSiteFix(site, { desktop });
        showToast(desktop ? 'Showing the desktop website' : 'Showing the mobile website');
        // After the native side has the new setting.
        setTimeout(() => activeRef()?.reload(), 100);
        return;
      }
      case 'hideElement':
        if (!plus.unlocked) return openPlus('none');
        setTimeout(startPicking, Platform.OS === 'ios' ? 350 : 0);
        return;
      case 'listen':
        if (!plus.unlocked) return openPlus('none');
        // After the menu sheet has closed: iOS shows one sheet at a time.
        setTimeout(openListen, Platform.OS === 'ios' ? 350 : 0);
        return;
      case 'back':
        return goBack();
      case 'forward':
        return activeRef()?.goForward();
      case 'share':
        setTimeout(() => {
          Share.share(Platform.OS === 'ios' ? { url } : { message: url }).catch(() => showToast('Couldn’t open sharing'));
        }, afterMenu);
        return;
      case 'quit':
        return quit();
    }
  };

  // Single: one bottom bar with back, the address, tabs and the menu (Safari's compact layout).
  const single = settings.addressBarPosition === 'single';
  const bottomBar = single || settings.addressBarPosition === 'bottom';
  // iOS web views scroll their own fields above the keyboard, so the browser isn't lifted for
  // them: that would leave a gap and resize the page (and any video in it). Only the find bar
  // is lifted there, and a bottom address bar slides up on its own (barShift) without
  // resizing the page underneath. Android lifts everything, as the window doesn't resize.
  const keyboardLift = Platform.OS === 'ios' && !findOpen ? 0 : keyboardHeight;
  const showToolbar = !single && (Platform.OS === 'ios' ? keyboardLift === 0 : !editing && keyboardHeight === 0);
  // The single bar's own margin above the home indicator.
  const singlePadBottom = Math.max(insets.bottom - 8, 4);
  // Part of the page area hidden by the keyboard on iOS (it sits over the toolbar first; the
  // single bar's home indicator margin goes under the keyboard).
  const keyboardOverPage =
    Platform.OS === 'ios'
      ? Math.max(0, keyboardHeight - (single ? singlePadBottom - 2 : showToolbar ? toolbarHeight : 0))
      : 0;
  const barShift = bottomBar && editing ? keyboardOverPage : 0;

  const chrome = incognito ? theme.privateBackground : theme.background;
  // iOS bottom layouts are edge to edge, like Safari: the page fills the screen, under the
  // status bar and the bars (which float over it, frosted).
  const edgeToEdge = Platform.OS === 'ios' && bottomBar;
  const barBg = edgeToEdge ? 'transparent' : chrome;
  // iOS 26+ keeps a page's fixed headers and footers clear of the bars, so the page scrolls
  // under them too; before that it stops at the top of the bars (still under the status bar).
  const underBars = edgeToEdge && ShieldEngine.obscuredInsetsSupported === true;
  // The part of the content area the floating bars cover.
  const coveredBottom = underBars ? Math.max(barsHeight, insets.bottom) : 0;
  // What the status bar and the bars cover (stable, so tab views don't re-render).
  const edge = useMemo(
    () => (edgeToEdge ? { top: insets.top, bottom: coveredBottom, safeBottom: underBars ? insets.bottom : 0 } : null),
    [edgeToEdge, underBars, insets.top, insets.bottom, coveredBottom],
  );
  const fg = incognito ? '#ECE6F7' : theme.text;
  // Edge to edge the status bar is over the page: light or dark text after the page's own
  // colour; over the browser's own screens (new tab, typing, overlays) after the app's theme.
  const overPage =
    edgeToEdge && overlay === 'none' && !editing && !!activeTab && !isBlank(activeTab.url) && activeTab.pageDark !== undefined;
  const statusStyle: 'light' | 'dark' = overPage ? (activeTab!.pageDark ? 'light' : 'dark') : incognito || theme.dark ? 'light' : 'dark';
  const normalCount = tabs.filter((t) => !t.incognito).length;
  const privateCount = tabs.length - normalCount;
  const tabCount = incognito ? privateCount : normalCount;
  const hasPage = !!activeTab && !isBlank(activeTab.url) && !(incognito && privateLocked);
  // A locked private tab doesn't reveal where it is.
  const visibleUrl = incognito && privateLocked ? '' : (activeTab?.url ?? '');
  const muted = incognito ? '#B3A8CC' : theme.muted;
  // Shrunk bars give way whenever the browser chrome is needed.
  const collapsed = chromeCollapsed && hasPage && !editing && !findOpen && !picking && keyboardHeight === 0 && overlay === 'none';

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
      inline={single && !editing}
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

  // Find, element picker, the shrunk bar, the address bar and the toolbar: under the page
  // (Android, top layout) or floating over it (iOS edge to edge).
  const bottomStack = (
    <>
      {findOpen ? (
        <View
          style={[
            styles.findBar,
            { backgroundColor: barBg, borderColor: theme.border },
            edgeToEdge && keyboardHeight === 0 && { paddingBottom: insets.bottom },
          ]}>
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
      {/* Picking an element to hide: the bar replaces the browser's bars. */}
      {picking ? (
        <View style={[styles.pickerBar, { backgroundColor: barBg, borderColor: theme.border, paddingBottom: insets.bottom + 8 }]}>
          <Text style={[styles.pickerHint, { color: fg }]}>Tap what to hide. “Bigger” selects what’s around it.</Text>
          <View style={styles.pickerButtons}>
            <Pressable onPress={cancelPicking} style={[styles.pickerButton, { backgroundColor: theme.surface }]} accessibilityRole="button">
              <Text style={[styles.pickerButtonText, { color: fg }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => activeRef()?.evaluateJavaScript(pickerBiggerScript()).catch(() => {})}
              style={[styles.pickerButton, { backgroundColor: theme.surface }]}
              accessibilityRole="button">
              <Text style={[styles.pickerButtonText, { color: fg }]}>Bigger</Text>
            </Pressable>
            <Pressable onPress={finishPicking} style={[styles.pickerButton, { backgroundColor: theme.accent }]} accessibilityRole="button">
              <Text style={[styles.pickerButtonText, { color: '#FFFFFF' }]}>Hide</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {bottomBar && !findOpen && !picking && collapsed ? (
        <View style={[styles.compactBottom, { paddingBottom: insets.bottom, backgroundColor: barBg }]}>{compactBar}</View>
      ) : null}
      {/* Top bar layout, shrunk: the page reaches the bottom edge, clear of the home indicator. */}
      {!bottomBar && collapsed ? <View style={{ height: insets.bottom, backgroundColor: chrome }} /> : null}

      {bottomBar && !findOpen && !picking && !collapsed ? (
        <View
          style={[
            styles.bottomBar,
            { top: edgeToEdge ? 0 : -barShift, backgroundColor: barBg, borderColor: incognito ? theme.privateSurface : theme.border },
            // The single bar is the last thing on screen: it keeps clear of the home indicator.
            single && { paddingTop: 0, paddingBottom: Platform.OS === 'android' && keyboardHeight > 0 ? 2 : singlePadBottom },
          ]}>
          {single && !editing ? (
            <View style={styles.singleRow}>
              <IconButton
                name={Platform.OS === 'ios' ? 'chevron-left' : 'arrow-left'}
                label="Back"
                color={fg}
                size={Platform.OS === 'ios' ? 26 : 22}
                disabled={!activeTab || (!activeTab.canGoBack && !activeTab.reader && !activeTab.openerId)}
                onPress={goBack}
                style={styles.singleButton}
              />
              <View style={styles.singleAddress}>{addressBar}</View>
              <IconButton
                name="square"
                label={`${tabCount} tabs`}
                color={fg}
                badge={String(Math.min(tabCount, 99))}
                onPress={openTabSwitcher}
                style={styles.singleButton}
              />
              <IconButton
                name={Platform.OS === 'ios' ? 'more-horizontal' : 'more-vertical'}
                label="Menu"
                color={fg}
                onPress={() => setMenuOpen(true)}
                style={styles.singleButton}
              />
            </View>
          ) : (
            addressBar
          )}
        </View>
      ) : null}

      {showToolbar && !collapsed && !picking ? (
        <View
          onLayout={(e) => setToolbarHeight(e.nativeEvent.layout.height)}
          // Safari hides the toolbar while the address is edited; on iOS it stays laid out so
          // the page keeps its size.
          pointerEvents={editing ? 'none' : 'auto'}
          style={[
            styles.toolbar,
            !bottomBar && styles.toolbarBorder,
            { backgroundColor: barBg, paddingBottom: insets.bottom, borderColor: incognito ? theme.privateSurface : theme.border },
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
    </>
  );

  return (
    // Left/right insets keep content clear of the navigation bar and cut-outs in landscape.
    <View
      style={[
        styles.root,
        edgeToEdge
          ? { backgroundColor: chrome }
          : { backgroundColor: chrome, paddingBottom: keyboardLift, paddingLeft: insets.left, paddingRight: insets.right },
      ]}>
      <StatusBar style={statusStyle} />
      {edgeToEdge ? (
        // The page scrolls under the status bar, seen through clear glass (like Safari's
        // scroll edge), tinted after the page so the time and battery stay readable.
        <View style={[styles.statusBackdrop, { height: insets.top }]} pointerEvents="none">
          <BlurView
            tint={statusStyle === 'light' ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
            intensity={60}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : (
        <View style={{ paddingTop: insets.top, backgroundColor: chrome, zIndex: 10 }}>
          {bottomBar ? null : collapsed ? compactBar : addressBar}
        </View>
      )}

      <View
        style={
          edgeToEdge
            ? [styles.edgeContent, { left: insets.left, right: insets.right, bottom: underBars ? 0 : barsHeight }]
            : styles.content
        }
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width && height) contentAspect.current = width / height;
        }}>
        {tabs
          .filter((t) => liveIds.has(t.id))
          .map((tab) => (
            // One tab failing to draw doesn't take the others (or the browser) with it.
            <ErrorBoundary
              key={tab.id}
              fallback={(reset) => (
                <View
                  style={[StyleSheet.absoluteFill, tab.id !== activeTab?.id && styles.hiddenTab]}
                  pointerEvents={tab.id === activeTab?.id ? 'auto' : 'none'}>
                  <ProblemScreen
                    theme={theme}
                    title="This tab ran into a problem"
                    body="Your other tabs are fine. Reloading usually fixes it."
                    primary={{ label: 'Reload tab', onPress: reset }}
                  />
                </View>
              )}>
            <BrowserTabView
              tab={tab}
              active={tab.id === activeTab?.id}
              theme={theme}
              registerRef={registerRef}
              onToast={showToast}
              onContextMenu={setContextTarget}
              onFullscreenChange={onFullscreenChange}
              onFindResult={onFindResult}
              onLinkAction={onLinkAction}
              onChromeChange={onChromeChange}
              onOpenReport={openReportFromPage}
              profileLabel={profiles.length && !tab.incognito ? profileName(profileOf(tab, profiles), profiles) : undefined}
              chromeCollapsed={tab.id === activeTab?.id && collapsed}
              edge={edge}
            />
            </ErrorBoundary>
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
            bottomInset={edgeToEdge ? coveredBottom + barShift : keyboardOverPage}
            topInset={edgeToEdge ? insets.top : 0}
            onOpen={(url) => openFromAddressBar(resolveInput(url, settings.searchEngine, settings.customSearchTemplate))}
            onSearch={searchFor}
            onFill={setAddressText}
          />
        ) : null}
        {toast ? (
          <View
            style={[styles.toast, { backgroundColor: theme.dark ? '#ECEDEF' : '#25272B' }, edgeToEdge && { bottom: coveredBottom + 16 }]}
            pointerEvents="none">
            <Text style={{ color: theme.dark ? '#16171A' : '#FFFFFF' }}>{toast}</Text>
          </View>
        ) : null}
      </View>

      {edgeToEdge ? (
        // Edge to edge (iOS): the bars float over the page, which scrolls under them.
        <View
          style={[styles.bottomOverlay, { bottom: keyboardLift + barShift }]}
          onLayout={(e) => {
            // Measured without the keyboard only: with it the bars lose their bottom padding,
            // and telling the page its area grew for that moment makes WebKit zoom it in.
            if (keyboardHeight === 0) setBarsHeight(Math.round(e.nativeEvent.layout.height));
          }}>
          {/* Glass: the page shows through, tinted lightly with the app's colour. */}
          <BlurView
            tint={incognito || theme.dark ? 'systemThinMaterialDark' : 'systemThinMaterialLight'}
            intensity={80}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: chrome, opacity: 0.2 }]} />
          {bottomStack}
        </View>
      ) : (
        bottomStack
      )}

      <MenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        theme={theme}
        hasPage={hasPage}
        bookmarked={!!activeTab && library.isBookmarked(activeTab.url)}
        readerActive={!!activeTab?.reader}
        desktop={!!activeTab && !!settings.siteFixes[siteKey(activeTab.url)]?.desktop}
        showQuit={Platform.OS === 'android'}
        clearsOnQuit={settings.clearDataOnExit}
        navigation={
          single
            ? {
                canGoBack: !!activeTab && (activeTab.canGoBack || activeTab.reader || !!activeTab.openerId),
                canGoForward: !!activeTab?.canGoForward,
              }
            : undefined
        }
        onAction={onMenu}
      />
      <ListenSheet
        visible={listenOpen}
        onClose={() => setListenOpen(false)}
        theme={theme}
        rate={activeTab?.playbackRate ?? 1}
        onRate={setPlaybackRate}
        sleep={sleep}
        onSleep={chooseSleep}
      />
      <ContextMenuSheet target={contextTarget} theme={theme} onClose={() => setContextTarget(null)} onAction={onContextAction} />
      <ShieldPanel
        visible={shieldOpen}
        onClose={() => setShieldOpen(false)}
        theme={theme}
        url={visibleUrl}
        blocked={activeTab?.blocked ?? 0}
        onChanged={() => setTimeout(() => activeRef()?.reload(), 50)}
        onOpenSettings={() => {
          setShieldOpen(false);
          setOverlay('settings');
        }}
        onOpenReport={() => {
          setShieldOpen(false);
          openReport('none');
        }}
        onOpenPlus={() => {
          setShieldOpen(false);
          openPlus('none');
        }}
      />

      {overlay !== 'none' ? (
        <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: theme.background }]}>
          <ErrorBoundary
            key={overlay}
            fallback={(reset) => (
              <ProblemScreen
                theme={theme}
                title="This screen couldn’t open"
                body="Something went wrong here. Your tabs are safe."
                primary={{ label: 'Try again', onPress: reset }}
                secondary={{ label: 'Close', onPress: () => setOverlay('none') }}
              />
            )}>
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
              profiles={profiles}
              onNewTab={(asPrivate, profileId) => {
                setOverlay('none');
                newTab(asPrivate, profileId);
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
              onClearedData={refreshBlockedTotal}
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
          ) : overlay === 'vault' ? (
            <VaultScreen
              theme={theme}
              onBack={() => setOverlay('none')}
              onOpen={(target) => {
                setOverlay('none');
                // The vault's pages open privately.
                openTab(target, { incognito: true });
              }}
            />
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
          </ErrorBoundary>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hiddenTab: { opacity: 0, zIndex: -1 },
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
  bottomOverlay: { position: 'absolute', left: 0, right: 0, zIndex: 10, overflow: 'hidden' },
  edgeContent: { position: 'absolute', top: 0 },
  statusBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, overflow: 'hidden' },
  // Back, the address, tabs and menu in one row; the buttons line up with the address field
  // (which has its progress line above it).
  singleRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 2 },
  singleAddress: { flex: 1 },
  singleButton: { width: 44, height: 44, marginBottom: 4 },
  compact: { height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 16 },
  compactText: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
  compactBottom: { paddingTop: 2 },
  pickerBar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  pickerHint: { fontSize: 14, textAlign: 'center' },
  pickerButtons: { flexDirection: 'row', gap: 10 },
  pickerButton: { flex: 1, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  pickerButtonText: { fontSize: 16, fontWeight: '600' },
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
