import { NativeModule, requireNativeModule } from 'expo';

import type { EngineStatus, ShieldEngineEvents, ShieldOptions } from './ShieldWebView.types';

declare class ShieldEngineModule extends NativeModule<ShieldEngineEvents> {
  /** Whether private tabs get their own cookie/storage jar on this device. */
  readonly privateTabsIsolated: boolean;
  /** Whether Stillweb Plus profiles (separate cookie/storage jars) work here (iOS 17+, recent Android WebView). */
  readonly profilesSupported: boolean;
  /** iOS 26+: pages can scroll under the app's bars (WebKit keeps fixed elements clear of them). */
  readonly obscuredInsetsSupported?: boolean;
  getStatus(): Promise<EngineStatus>;
  /** Verifies and activates a downloaded filter bundle directory; resolves with its version. */
  applyFilterUpdate(directory: string): Promise<string | null>;
  /** Rebuilds the engine with only these filter list ids (null = all). */
  setEnabledLists(ids: string[] | null): Promise<string | null>;
  setDisabledSites(hosts: string[]): void;
  /** Per-site desktop website, JavaScript off and hidden elements (by site, host without www.). */
  setSiteFixes(fixes: Record<string, { desktop?: boolean; noScript?: boolean; hidden?: string[] }>): void;
  setOptions(options: ShieldOptions): void;
  resetStats(): void;
  clearBrowsingData(): Promise<void>;
  clearPrivateData(): Promise<void>;
  /** Deletes a profile's cookies and site data; call after its tabs are closed. */
  deleteProfileData(id: string): Promise<void>;
  startDownload(options: {
    url: string;
    userAgent?: string;
    contentDisposition?: string;
    mimeType?: string;
    incognito?: boolean;
    /** Sends the cookies of this Stillweb Plus profile. */
    profileId?: string;
  }): Promise<{ id: number; fileName: string }>;
  getDownloads(ids: number[]): Promise<
    { id: number; status: 'pending' | 'running' | 'paused' | 'done' | 'failed'; bytes: number; total: number }[]
  >;
  openDownload(id: number): Promise<boolean>;
  /** iOS: state of downloaded files by path (missing = deleted from Files). */
  getFileDownloads(
    paths: string[],
  ): Promise<{ path: string; status: 'running' | 'done' | 'failed' | 'missing'; bytes: number; total: number }[]>;
  /** iOS: previews a downloaded file (with Share and Save to Files); false if it's gone. */
  openFile(path: string): Promise<boolean>;
  /** iOS: switches the app icon ("Sunset"; null = standard); false if the system doesn't allow it. */
  setAppIcon(name: string | null): Promise<boolean>;
  /** iOS: the alternate icon in use, or null for the standard one. */
  getAppIcon(): Promise<string | null>;
  /** iOS: deletes a downloaded file (the vault's aren't reachable from the Files app). */
  deleteFile(path: string): Promise<boolean>;
  /** Hides the app's content from the recent-apps / app switcher preview (and, on Android, screenshots). */
  setSecureWindow(secure: boolean): Promise<void>;
  /** Debug builds (Android): route web traffic through `host:port`; null clears it. */
  setDebugProxy(hostPort: string | null): Promise<boolean>;
  /** Opens a link in another app (mailto:, tel:, intent:, ...). */
  openExternal(url: string): Promise<boolean>;
  /** Listen Mode: pauses all media in every tab after `seconds` (null cancels); fires onSleepTimerFired. */
  setSleepTimer(seconds: number | null): Promise<void> | void;
}

export default requireNativeModule<ShieldEngineModule>('ShieldEngine');
