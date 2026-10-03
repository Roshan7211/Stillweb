import { ShieldEngine } from '../../native/shield-webview';

let applied: Promise<void> | null = null;

/**
 * Development only: when EXPO_PUBLIC_DEV_PROXY is set (see .env.local), route WebView
 * traffic through it so a USB-connected phone without its own network can browse.
 * Resolves immediately in release builds.
 */
export function applyDevProxy(): Promise<void> {
  const proxy = process.env.EXPO_PUBLIC_DEV_PROXY;
  if (!__DEV__ || !proxy) return Promise.resolve();
  applied ??= ShieldEngine.setDebugProxy(proxy).then(
    () => undefined,
    () => undefined,
  );
  return applied;
}
