import * as DocumentPicker from 'expo-document-picker';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Alert, Animated, AppState, Easing, Platform, StyleSheet } from 'react-native';

import { ShieldEngine, ShieldWebView, type ShieldWebViewRef } from '../../../native/shield-webview';
import { useLibraryActions } from '../../browser/library';
import { setBlockedTotal } from '../../browser/blockedTotal';
import { usePrivacyStatsActions } from '../../browser/privacyStats';
import { useSettings } from '../../browser/settings';
import { useTabActions, type Tab } from '../../browser/tabs';
import { rateScript, stopAtEndScript } from '../../browser/listen';
import { pageLookScript, parsePageLook } from '../../browser/pageTheme';
import type { LoadError } from '../../browser/loadErrors';
import { isBlank, searchUrl, siteKey } from '../../browser/url';
import type { Theme } from '../theme';
import type { ContextTarget } from './ContextMenuSheet';
import LoadErrorPage from './LoadErrorPage';
import NewTabPage from './NewTabPage';

type Props = {
  tab: Tab;
  active: boolean;
  theme: Theme;
  registerRef: (id: string, ref: ShieldWebViewRef | null) => void;
  onToast: (message: string) => void;
  onContextMenu: (target: ContextTarget) => void;
  onFullscreenChange: (tabId: string, fullscreen: boolean) => void;
  onFindResult: (tabId: string, active: number, count: number) => void;
  /** iOS long-press menu: open the link in a new (private) tab. */
  onLinkAction: (target: ContextTarget, action: 'open' | 'openPrivate') => void;
  /** iOS: the page was scrolled so the bars should shrink (or come back). */
  onChromeChange: (collapsed: boolean) => void;
  /** Whether the bars are shrunk (only passed to the active tab). */
  chromeCollapsed: boolean;
  /** Opens the privacy report (from the new tab page's stats). */
  onOpenReport: () => void;
  /** Stillweb Plus: name of the tab's profile, shown on its new tab page. */
  profileLabel?: string;
  /**
   * iOS edge to edge: the page fills the screen; `top`/`bottom` is what the status bar and the
   * app's bars cover, `safeBottom` the home indicator area within `bottom`. Memoized by the caller.
   */
  edge?: { top: number; bottom: number; safeBottom: number } | null;
  /**
   * Moving to this tab: it comes in with a short animation, played again whenever the number
   * changes (only passed to the active tab). `enterFrom` is where it comes from: the side when
   * swiping between tabs, otherwise it grows into place.
   */
  enterKey?: number;
  enterFrom?: TabEnter;
  /** The tab that was just left stays on screen under the one coming in, for that moment. */
  leaving?: boolean;
  /**
   * The bars are drawn in the page's colours (layouts where the page doesn't scroll under
   * them): the page's edges are looked at again from time to time while it is on screen.
   */
  tintBars?: boolean;
};

export type TabEnter = 'zoom' | 'next' | 'previous';

// People who turned animations down in the system settings get none here.
let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled()
  .then((value) => {
    reduceMotion = value;
  })
  .catch(() => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
  reduceMotion = value;
});

const ENTER_MS = 220;

/** Maps an <input accept> list to MIME types the system picker understands. */
function pickerTypes(accept: string): string[] {
  const types = accept
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.includes('/'));
  return types.length ? types : ['*/*'];
}

// Memoized: a page's progress and title updates re-render only its own view. Callers pass
// stable callbacks (they take the tab id instead of closing over it).
export default memo(BrowserTabView);

function BrowserTabView(props: Props) {
  const { tab, active, theme, registerRef, onToast, onContextMenu, onFullscreenChange, onFindResult } = props;
  const { onLinkAction, onChromeChange, chromeCollapsed, onOpenReport, profileLabel, edge } = props;
  const { enterKey = 0, enterFrom = 'zoom', leaving = false, tintBars = false } = props;
  // WebKit adds the safe area itself; it's told only what the app's bars cover beyond it.
  const chromeInsets = useMemo(() => (edge ? { top: 0, bottom: Math.max(0, edge.bottom - edge.safeBottom) } : undefined), [edge]);
  const pageInsets = edge ?? undefined;
  const { settings } = useSettings();
  const { updateTab, openTab, navigate, closeTab } = useTabActions();
  const library = useLibraryActions();
  const stats = usePrivacyStatsActions();
  const ref = useRef<ShieldWebViewRef>(null);
  // The page's running count, to turn each update into the newly blocked requests.
  const lastBlocked = useRef(0);
  const lastVisit = useRef<string>('');
  // The URL the web view is created with. App-driven navigations after that (address bar,
  // bookmarks) bump tab.navigationKey and go through loadUrl.
  const initialUrl = useRef<string>(tab.url);
  // A page the tab already had open (see Tab.visited), as opposed to one just asked for.
  const [restored] = useState(() => !!tab.visited);
  const handledKey = useRef(tab.navigationKey);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  // Progress arrives many times a second; the bar only needs visible steps.
  const lastProgress = useRef(0);
  if (isBlank(initialUrl.current) && !isBlank(tab.url)) {
    // First navigation away from the new tab page: the view mounts with this URL.
    initialUrl.current = tab.url;
    handledKey.current = tab.navigationKey;
  }
  // A page's pop-up starts out blank and is already loading in native code.
  const showWeb = !isBlank(initialUrl.current) || !!tab.popupId;

  // A new web view starts out silent, whatever the one before it last reported.
  useEffect(() => {
    updateTab(tab.id, { playing: undefined });
  }, [tab.id, updateTab]);

  useEffect(() => {
    if (tab.navigationKey === handledKey.current) return;
    handledKey.current = tab.navigationKey;
    ref.current?.loadUrl(tab.url);
  }, [tab.navigationKey, tab.url]);

  const setRef = (instance: ShieldWebViewRef | null) => {
    ref.current = instance;
    registerRef(tab.id, instance);
  };

  // What the page looks like at its edges (see pageLookScript). The tab is only updated when
  // something changed, so looking again costs no re-render.
  const look = useRef({ pageDark: tab.pageDark, pageTop: tab.pageTop, pageBottom: tab.pageBottom, error: false, reader: false });
  useEffect(() => {
    look.current = { pageDark: tab.pageDark, pageTop: tab.pageTop, pageBottom: tab.pageBottom, error: !!loadError, reader: !!tab.reader };
  });
  const measureLook = () => {
    ref.current
      ?.evaluateJavaScript(pageLookScript())
      .then((raw) => {
        const now = look.current;
        // The app's own pages (an error, reader view) are drawn in the app's theme.
        if (now.error || now.reader) return;
        const next = parsePageLook(raw);
        if (next.pageDark !== now.pageDark || next.pageTop !== now.pageTop || next.pageBottom !== now.pageBottom) {
          updateTab(tab.id, next);
        }
      })
      .catch(() => {});
  };
  const measure = useRef(measureLook);
  useEffect(() => {
    measure.current = measureLook;
  });
  // A page's header changes as it is scrolled, and app-like sites change pages without
  // loading: while the bars follow the page, it is looked at every little while.
  useEffect(() => {
    if (!tintBars || !active || !showWeb) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') measure.current();
    }, 1500);
    return () => clearInterval(timer);
  }, [tintBars, active, showWeb]);

  // Coming on screen: a short fade while the page grows into place (or slides in from the side
  // it was swiped from). Runs on the native side, so a busy page doesn't make it stutter.
  // One value owns how visible the tab is, in every state: 0 while it is hidden, 1 while it is
  // shown or left behind under the tab coming in, and running from 0 to 1 as it comes in.
  const [enter] = useState(() => new Animated.Value(0));
  const played = useRef(-1);
  useEffect(() => {
    if (!active) {
      played.current = -1;
      enter.stopAnimation();
      enter.setValue(leaving ? 1 : 0);
      return;
    }
    if (played.current === enterKey) return;
    played.current = enterKey;
    if (reduceMotion) {
      enter.setValue(1);
      return;
    }
    enter.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [active, leaving, enterKey, enter]);
  const entering = useMemo(
    () => ({
      opacity: enter,
      transform:
        enterFrom === 'zoom'
          ? [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }]
          : [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [enterFrom === 'next' ? 48 : -48, 0] }) }],
    }),
    [enter, enterFrom],
  );
  const frame = (children: ReactNode) => (
    <Animated.View
      style={[StyleSheet.absoluteFill, active ? styles.shown : leaving ? styles.leaving : styles.hidden, entering]}
      pointerEvents={active ? 'auto' : 'none'}>
      {children}
    </Animated.View>
  );

  if (!showWeb) {
    return frame(
      <NewTabPage
        theme={theme}
        incognito={tab.incognito}
        active={active}
        onOpen={(url) => navigate(tab.id, url)}
        onOpenReport={onOpenReport}
        profile={profileLabel}
        insets={pageInsets}
      />,
    );
  }

  return frame(
    <>
      <ShieldWebView
        ref={setRef}
        style={StyleSheet.absoluteFill}
        initialUrl={initialUrl.current}
        popupId={tab.popupId}
        restored={restored}
        active={active}
        chromeCollapsed={chromeCollapsed}
        incognito={tab.incognito}
        profileId={tab.profileId}
        chromeInsets={chromeInsets}
        forceDark={theme.dark && settings.darkPages}
        textZoom={settings.textZoom}
        onNavigationStateChange={({ nativeEvent: s }) => {
          // A view that has no page (just created, or its page was taken out of memory) reports
          // no address: the tab keeps the one it has instead of turning into an empty tab.
          const keepAddress = isBlank(s.url) && !isBlank(tab.url);
          updateTab(tab.id, {
            ...(keepAddress ? null : { url: s.url, title: s.title }),
            // Also for a page's pop-up, whose first load starts before this view exists.
            ...(isBlank(s.url) ? null : { visited: true }),
            canGoBack: s.canGoBack,
            canGoForward: s.canGoForward,
            loading: s.loading,
            progress: s.progress,
            shieldsActive: s.shieldsActive,
            secure: s.secure,
          });
          if (tab.incognito || isBlank(s.url)) return;
          if (s.url !== lastVisit.current) {
            lastVisit.current = s.url;
            library.addVisit(s.url, s.title);
          } else {
            library.updateVisitTitle(s.url, s.title);
          }
        }}
        onLoadStart={() => {
          lastProgress.current = 0;
          setLoadError(null);
          updateTab(tab.id, { loading: true, reader: false });
        }}
        onLoadError={({ nativeEvent }) => {
          // A navigation that turned into a download (or was replaced) isn't a failure.
          if (/ERR_ABORTED|ERR_BLOCKED_BY_RESPONSE/i.test(nativeEvent.description) || nativeEvent.code === -999) return;
          setLoadError(nativeEvent);
          // Stillweb's error page is drawn in the app's theme: the status bar and bars follow that.
          updateTab(tab.id, { pageDark: undefined, pageTop: undefined, pageBottom: undefined });
        }}
        onCloseRequest={() => {
          // Like other browsers, pages may only close windows that a page opened.
          if (tab.openerId) closeTab(tab.id);
        }}
        onLoadEnd={({ nativeEvent: { url } }) => {
          updateTab(tab.id, { loading: false, progress: 1 });
          // Listen Mode: the tab's playback speed carries over to the new page.
          if (tab.playbackRate && tab.playbackRate !== 1) ref.current?.evaluateJavaScript(rateScript(tab.playbackRate)).catch(() => {});
          // Edge to edge, the status bar sits over the page: its text follows the page's colour.
          // Elsewhere the bars themselves take the page's colours.
          if (Platform.OS === 'ios' || tintBars) measureLook();
          // "End of this one" follows a playlist onto its next page (same site only).
          if (tab.stopAtEnd) {
            if (tab.stopAtEnd !== siteKey(url)) updateTab(tab.id, { stopAtEnd: undefined });
            else {
              ref.current
                ?.evaluateJavaScript(stopAtEndScript('resume'))
                .then((state) => state === '"done"' && updateTab(tab.id, { stopAtEnd: undefined }))
                .catch(() => {});
            }
          }
        }}
        onLoadProgress={({ nativeEvent: { progress } }) => {
          if (progress < 1 && Math.abs(progress - lastProgress.current) < 0.05) return;
          lastProgress.current = progress;
          updateTab(tab.id, { progress });
        }}
        onBlockedCountChange={({ nativeEvent }) => {
          const { blocked, hosts } = nativeEvent;
          // A lower count means a new page started counting from zero.
          const added = blocked >= lastBlocked.current ? blocked - lastBlocked.current : blocked;
          lastBlocked.current = blocked;
          if (tab.incognito) stats.record(added);
          else stats.record(added, isBlank(tab.url) ? null : siteKey(tab.url), hosts);
          updateTab(tab.id, { blocked });
          setBlockedTotal(nativeEvent.totalBlocked);
        }}
        onOpenWindow={({ nativeEvent }) => {
          openTab(nativeEvent.url, { incognito: tab.incognito, openerId: tab.id, popupId: nativeEvent.popupId });
        }}
        onLinkAction={({ nativeEvent }) => onLinkAction({ link: nativeEvent.url, image: '', incognito: tab.incognito }, nativeEvent.action)}
        onChromeChange={({ nativeEvent }) => active && onChromeChange(nativeEvent.collapsed)}
        onMediaStateChange={({ nativeEvent }) => updateTab(tab.id, { playing: nativeEvent.playing })}
        onPopupBlocked={({ nativeEvent }) => {
          if (active) onToast(nativeEvent.kind === 'redirect' ? 'Blocked a redirect' : 'Blocked a pop-up');
        }}
        onDownloadRequest={async ({ nativeEvent: d }) => {
          if (d.handledNatively) {
            const fileName = d.filePath?.split('/').pop() ?? 'file';
            // Private downloads stay out of the app's list (the file is in Files › Stillweb ›
            // Downloads), unless they went to the vault, which lists them behind Face ID.
            const inVault = tab.incognito && !!d.filePath?.includes('/Vault/');
            if (!tab.incognito || inVault) library.addDownload({ url: d.url, fileName, filePath: d.filePath, ...(inVault ? { vault: true } : {}) });
            onToast(`Downloading ${fileName}`);
            return;
          }
          try {
            const result = await ShieldEngine.startDownload({ ...d, profileId: tab.profileId });
            if (!tab.incognito) library.addDownload({ url: d.url, fileName: result.fileName, nativeId: result.id });
            onToast(`Downloading ${result.fileName}`);
          } catch {
            onToast('Download failed');
          }
        }}
        onContextMenu={({ nativeEvent }) => onContextMenu({ ...nativeEvent, incognito: tab.incognito })}
        onFullscreenChange={({ nativeEvent }) => onFullscreenChange(tab.id, nativeEvent.fullscreen)}
        onFindResult={({ nativeEvent }) => onFindResult(tab.id, nativeEvent.active, nativeEvent.count)}
        onFileChooser={async ({ nativeEvent }) => {
          let uris: string[] | null = null;
          try {
            const result = await DocumentPicker.getDocumentAsync({
              type: pickerTypes(nativeEvent.acceptTypes),
              multiple: nativeEvent.multiple,
              // Hand the page the picked document itself; nothing is copied into app storage.
              copyToCacheDirectory: false,
            });
            if (!result.canceled) uris = result.assets.map((a) => a.uri);
          } finally {
            ref.current?.resolveFileChooser(uris);
          }
        }}
        onExternalLink={({ nativeEvent }) => {
          Alert.alert('Open in another app?', nativeEvent.url.slice(0, 120), [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open',
              onPress: () =>
                ShieldEngine.openExternal(nativeEvent.url)
                  .then((ok) => {
                    if (!ok) onToast(Platform.OS === 'android' ? 'No app can open this link' : 'Could not open link');
                  })
                  .catch(() => onToast('Could not open link')),
            },
          ]);
        }}
      />
      {loadError ? (
        <LoadErrorPage
          theme={theme}
          error={loadError}
          canGoBack={tab.canGoBack}
          insets={pageInsets}
          onRetry={() => {
            setLoadError(null);
            if (loadError.url) ref.current?.loadUrl(loadError.url);
            else ref.current?.reload();
          }}
          onBack={() => {
            setLoadError(null);
            ref.current?.goBack();
          }}
          onSearch={(query) => {
            setLoadError(null);
            navigate(tab.id, searchUrl(query, settings.searchEngine, settings.customSearchTemplate));
          }}
        />
      ) : null}
    </>,
  );
}

const styles = StyleSheet.create({
  // Never above zero: the suggestions, the lock screen and messages are drawn over the tab.
  shown: { zIndex: 0 },
  leaving: { zIndex: -1 },
  hidden: { zIndex: -2 },
});
