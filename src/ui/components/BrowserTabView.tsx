import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ShieldEngine, ShieldWebView, type ShieldWebViewRef } from '../../../native/shield-webview';
import { useLibrary } from '../../browser/library';
import { useSettings } from '../../browser/settings';
import { useTabs, type Tab } from '../../browser/tabs';
import { displayHost, isBlank } from '../../browser/url';
import type { Theme } from '../theme';
import type { ContextTarget } from './ContextMenuSheet';
import NewTabPage from './NewTabPage';
import { Icon } from './primitives';

type Props = {
  tab: Tab;
  active: boolean;
  theme: Theme;
  totalBlocked: number;
  onTotalBlocked: (n: number) => void;
  registerRef: (id: string, ref: ShieldWebViewRef | null) => void;
  onToast: (message: string) => void;
  onContextMenu: (target: ContextTarget) => void;
  onFullscreenChange: (fullscreen: boolean) => void;
  onFindResult: (active: number, count: number) => void;
};

type LoadError = { url: string; code: number; description: string };

/** Plain-language explanation for a failed page load (Android WebView and iOS URL error codes). */
function describeError(e: LoadError): { icon: 'wifi-off' | 'search' | 'clock' | 'alert-triangle'; title: string; body: string } {
  const host = displayHost(e.url) || 'this site';
  const d = e.description.toUpperCase();
  if (e.code === -1009 || d.includes('INTERNET_DISCONNECTED')) {
    return { icon: 'wifi-off', title: "You're offline", body: 'Check your Wi-Fi or mobile data, then try again.' };
  }
  if (e.code === -2 || e.code === -1003 || d.includes('NAME_NOT_RESOLVED')) {
    return { icon: 'search', title: `Can't find ${host}`, body: 'Check the address for typos, or search for the site instead.' };
  }
  if (e.code === -8 || e.code === -1001 || d.includes('TIMED_OUT')) {
    return { icon: 'clock', title: `${host} is taking too long`, body: 'The site may be busy or down. Try again in a moment.' };
  }
  if (d.includes('SSL_PROTOCOL') || d.includes('CONNECTION_REFUSED') || d.includes('CONNECTION_RESET') || d.includes('ACCESS_DENIED')) {
    return { icon: 'alert-triangle', title: `Can't connect to ${host}`, body: 'The site or your network refused the connection. It may be blocked on this network.' };
  }
  if (e.code === -11 || (e.code <= -1200 && e.code >= -1206) || d.includes('CERT')) {
    return {
      icon: 'alert-triangle',
      title: 'This connection isn’t private',
      body: `${host} has an invalid security certificate, so the page was stopped to protect your information.`,
    };
  }
  return { icon: 'alert-triangle', title: `Can't open ${host}`, body: 'The site couldn’t be reached. Try again in a moment.' };
}

/** Maps an <input accept> list to MIME types the system picker understands. */
function pickerTypes(accept: string): string[] {
  const types = accept
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.includes('/'));
  return types.length ? types : ['*/*'];
}

export default function BrowserTabView(props: Props) {
  const { tab, active, theme, totalBlocked, onTotalBlocked, registerRef, onToast, onContextMenu, onFullscreenChange, onFindResult } = props;
  const { settings } = useSettings();
  const { updateTab, openTab, navigate, closeTab } = useTabs();
  const library = useLibrary();
  const ref = useRef<ShieldWebViewRef>(null);
  const lastVisit = useRef<string>('');
  // The URL the web view is created with. App-driven navigations after that (address bar,
  // bookmarks) bump tab.navigationKey and go through loadUrl.
  const initialUrl = useRef<string>(tab.url);
  const handledKey = useRef(tab.navigationKey);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  if (isBlank(initialUrl.current) && !isBlank(tab.url)) {
    // First navigation away from the new tab page: the view mounts with this URL.
    initialUrl.current = tab.url;
    handledKey.current = tab.navigationKey;
  }
  const showWeb = !isBlank(initialUrl.current);

  useEffect(() => {
    if (tab.navigationKey === handledKey.current) return;
    handledKey.current = tab.navigationKey;
    ref.current?.loadUrl(tab.url);
  }, [tab.navigationKey, tab.url]);

  const setRef = (instance: ShieldWebViewRef | null) => {
    ref.current = instance;
    registerRef(tab.id, instance);
  };

  if (!showWeb) {
    return (
      <View style={[StyleSheet.absoluteFill, !active && styles.hidden]} pointerEvents={active ? 'auto' : 'none'}>
        <NewTabPage theme={theme} incognito={tab.incognito} totalBlocked={totalBlocked} onOpen={(url) => navigate(tab.id, url)} />
      </View>
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, !active && styles.hidden]} pointerEvents={active ? 'auto' : 'none'}>
      <ShieldWebView
        ref={setRef}
        style={StyleSheet.absoluteFill}
        initialUrl={initialUrl.current}
        incognito={tab.incognito}
        forceDark={theme.dark && settings.darkPages}
        textZoom={settings.textZoom}
        onNavigationStateChange={({ nativeEvent: s }) => {
          updateTab(tab.id, {
            url: s.url,
            title: s.title,
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
          setLoadError(null);
          updateTab(tab.id, { loading: true, reader: false });
        }}
        onLoadError={({ nativeEvent }) => {
          // A navigation that turned into a download (or was replaced) isn't a failure.
          if (/ERR_ABORTED|ERR_BLOCKED_BY_RESPONSE/i.test(nativeEvent.description) || nativeEvent.code === -999) return;
          setLoadError(nativeEvent);
        }}
        onCloseRequest={() => {
          // Like other browsers, pages may only close windows that a page opened.
          if (tab.openerId) closeTab(tab.id);
        }}
        onLoadEnd={() => updateTab(tab.id, { loading: false, progress: 1 })}
        onLoadProgress={({ nativeEvent }) => updateTab(tab.id, { progress: nativeEvent.progress })}
        onBlockedCountChange={({ nativeEvent }) => {
          updateTab(tab.id, { blocked: nativeEvent.blocked });
          onTotalBlocked(nativeEvent.totalBlocked);
        }}
        onOpenWindow={({ nativeEvent }) => {
          openTab(nativeEvent.url, { incognito: tab.incognito, openerId: tab.id });
        }}
        onPopupBlocked={({ nativeEvent }) => {
          if (active) onToast(nativeEvent.kind === 'redirect' ? 'Blocked a redirect' : 'Blocked a pop-up');
        }}
        onDownloadRequest={async ({ nativeEvent: d }) => {
          if (d.handledNatively) {
            const fileName = d.filePath?.split('/').pop() ?? 'file';
            library.addDownload({ url: d.url, fileName, filePath: d.filePath });
            onToast(`Downloading ${fileName}`);
            return;
          }
          try {
            const result = await ShieldEngine.startDownload(d);
            if (!tab.incognito) library.addDownload({ url: d.url, fileName: result.fileName, nativeId: result.id });
            onToast(`Downloading ${result.fileName}`);
          } catch (e) {
            onToast('Download failed');
          }
        }}
        onContextMenu={({ nativeEvent }) => onContextMenu({ ...nativeEvent, incognito: tab.incognito })}
        onFullscreenChange={({ nativeEvent }) => onFullscreenChange(nativeEvent.fullscreen)}
        onFindResult={({ nativeEvent }) => onFindResult(nativeEvent.active, nativeEvent.count)}
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
                ShieldEngine.openExternal(nativeEvent.url).then((ok) => {
                  if (!ok) onToast(Platform.OS === 'android' ? 'No app can open this link' : 'Could not open link');
                }),
            },
          ]);
        }}
      />
      {loadError ? (
        <ErrorPage
          theme={theme}
          error={loadError}
          canGoBack={tab.canGoBack}
          onRetry={() => {
            setLoadError(null);
            ref.current?.loadUrl(loadError.url);
          }}
          onBack={() => {
            setLoadError(null);
            ref.current?.goBack();
          }}
        />
      ) : null}
    </View>
  );
}

function ErrorPage({
  theme,
  error,
  canGoBack,
  onRetry,
  onBack,
}: {
  theme: Theme;
  error: LoadError;
  canGoBack: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  const info = describeError(error);
  return (
    <View style={[StyleSheet.absoluteFill, styles.error, { backgroundColor: theme.background }]}>
      <Icon name={info.icon} size={40} color={theme.muted} />
      <Text style={[styles.errorTitle, { color: theme.text }]}>{info.title}</Text>
      <Text style={[styles.errorBody, { color: theme.muted }]}>{info.body}</Text>
      <View style={styles.errorButtons}>
        {canGoBack ? (
          <Pressable onPress={onBack} style={[styles.errorButton, { backgroundColor: theme.surface }]} accessibilityRole="button">
            <Text style={{ color: theme.text, fontWeight: '600' }}>Go back</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onRetry} style={[styles.errorButton, { backgroundColor: theme.accent }]} accessibilityRole="button">
          <Text style={{ color: '#FFFFFF', fontWeight: '600' }}>Try again</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { opacity: 0, zIndex: -1 },
  error: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  errorTitle: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  errorBody: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  errorButtons: { flexDirection: 'row', gap: 12, marginTop: 12 },
  errorButton: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
});
