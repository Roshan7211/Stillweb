import type { ViewProps } from 'react-native';

type NativeEvent<T> = { nativeEvent: T };

export type NavigationState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** 0..1 */
  progress: number;
  /** False when shields are off globally or for this site. */
  shieldsActive: boolean;
  secure: boolean;
};

export type BlockedCount = {
  /** Requests blocked on the current page. */
  blocked: number;
  /** Requests blocked since install (or the last stats reset). */
  totalBlocked: number;
};

export type DownloadRequest = {
  url: string;
  userAgent: string;
  contentDisposition: string;
  mimeType: string;
  contentLength: number;
  incognito: boolean;
  /** iOS: the web view already started the download (saved to Documents/Downloads). */
  handledNatively?: boolean;
  filePath?: string;
};

export type ShieldWebViewProps = ViewProps & {
  /** Loaded once when the view is created; navigate later with `ref.loadUrl`. */
  initialUrl?: string;
  /** Private tab: isolated cookies/storage where the platform supports it. */
  incognito?: boolean;
  /** Darken pages that have no dark theme of their own. */
  forceDark?: boolean;
  /** Text size in percent (Android). */
  textZoom?: number;
  onLoadStart?: (event: NativeEvent<{ url: string }>) => void;
  onLoadEnd?: (event: NativeEvent<{ url: string }>) => void;
  onLoadProgress?: (event: NativeEvent<{ progress: number }>) => void;
  onLoadError?: (event: NativeEvent<{ url: string; code: number; description: string }>) => void;
  onNavigationStateChange?: (event: NativeEvent<NavigationState>) => void;
  onBlockedCountChange?: (event: NativeEvent<BlockedCount>) => void;
  /** A user-initiated new window (target=_blank, window.open after a tap). */
  onOpenWindow?: (event: NativeEvent<{ url: string; incognito: boolean }>) => void;
  /** A pop-up or script redirect that shields stopped. */
  onPopupBlocked?: (event: NativeEvent<{ url: string; kind: 'popup' | 'redirect' }>) => void;
  onDownloadRequest?: (event: NativeEvent<DownloadRequest>) => void;
  /** A tapped link to another app (mailto:, tel:, intent:, ...). */
  onExternalLink?: (event: NativeEvent<{ url: string }>) => void;
  /** Android: long-press on a link and/or image ('' when absent). */
  onContextMenu?: (event: NativeEvent<{ link: string; image: string }>) => void;
  /** Android: the page asked for files; answer with `ref.resolveFileChooser`. */
  onFileChooser?: (event: NativeEvent<{ acceptTypes: string; multiple: boolean }>) => void;
  /** Android: page video entered or left fullscreen. */
  onFullscreenChange?: (event: NativeEvent<{ fullscreen: boolean }>) => void;
  /** Find-in-page progress: `active` is 1-based; `count` -1 means unknown (iOS). */
  onFindResult?: (event: NativeEvent<{ active: number; count: number }>) => void;
  /** The page called window.close(). */
  onCloseRequest?: (event: NativeEvent<{ reason: string }>) => void;
};

export type ShieldWebViewRef = {
  loadUrl(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stopLoading(): Promise<void>;
  clearHistory(): Promise<void>;
  findInPage(query: string): Promise<void>;
  findNext(forward: boolean): Promise<void>;
  clearFind(): Promise<void>;
  /** Completes onFileChooser with picked file URIs, or null when cancelled. */
  resolveFileChooser(uris: string[] | null): Promise<void>;
  /** Saves a small JPEG of the visible page (for the tab switcher); resolves with its file URI. */
  captureThumbnail(key: string): Promise<string | null>;
  /** Leaves fullscreen video; resolves with whether it was showing. */
  exitFullscreen(): Promise<boolean>;
  /** Resolves with the JSON-encoded result, like WebView.evaluateJavascript. */
  evaluateJavaScript(script: string): Promise<string | null>;
};

export type EngineStatus = {
  ready: boolean;
  version: string | null;
  source: 'bundled' | 'downloaded' | 'none';
  buildMillis: number;
  lastError: string | null;
  enabledLists: string[] | null;
  totalBlocked: number;
};

export type ShieldOptions = {
  enabled?: boolean;
  httpsUpgrade?: boolean;
  blockPopups?: boolean;
  cosmeticFiltering?: boolean;
  blockThirdPartyCookies?: boolean;
  /** Keep audio/video playing when the app is in the background (media notification on Android). */
  backgroundPlay?: boolean;
};

export type ShieldEngineEvents = {
  onEngineChanged: (status: EngineStatus) => void;
};
