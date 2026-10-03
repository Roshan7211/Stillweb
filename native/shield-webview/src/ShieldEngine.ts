import { NativeModule, requireNativeModule } from 'expo';

import type { EngineStatus, ShieldEngineEvents, ShieldOptions } from './ShieldWebView.types';

declare class ShieldEngineModule extends NativeModule<ShieldEngineEvents> {
  /** Whether private tabs get their own cookie/storage jar on this device. */
  readonly privateTabsIsolated: boolean;
  getStatus(): Promise<EngineStatus>;
  /** Verifies and activates a downloaded filter bundle directory; resolves with its version. */
  applyFilterUpdate(directory: string): Promise<string | null>;
  /** Rebuilds the engine with only these filter list ids (null = all). */
  setEnabledLists(ids: string[] | null): Promise<string | null>;
  setDisabledSites(hosts: string[]): void;
  setOptions(options: ShieldOptions): void;
  resetStats(): void;
  clearBrowsingData(): Promise<void>;
  clearPrivateData(): Promise<void>;
  startDownload(options: {
    url: string;
    userAgent?: string;
    contentDisposition?: string;
    mimeType?: string;
    incognito?: boolean;
  }): Promise<{ id: number; fileName: string }>;
  getDownloads(ids: number[]): Promise<
    { id: number; status: 'pending' | 'running' | 'paused' | 'done' | 'failed'; bytes: number; total: number }[]
  >;
  openDownload(id: number): Promise<boolean>;
  /** Android: hide the window from screenshots and the recent-apps preview. */
  setSecureWindow(secure: boolean): Promise<void>;
  /** Debug builds (Android): route web traffic through `host:port`; null clears it. */
  setDebugProxy(hostPort: string | null): Promise<boolean>;
  /** Opens a link in another app (mailto:, tel:, intent:, ...). */
  openExternal(url: string): Promise<boolean>;
}

export default requireNativeModule<ShieldEngineModule>('ShieldEngine');
