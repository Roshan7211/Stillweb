import { useSyncExternalStore } from 'react';

import { ShieldEngine } from '../../native/shield-webview';

/**
 * All-time blocked count. Pages report it many times a second while loading, so it lives
 * outside React state: only what shows it (new tab page, shield panel) re-renders.
 */
let total = 0;
const listeners = new Set<() => void>();

export function setBlockedTotal(n: number) {
  if (n === total) return;
  total = n;
  listeners.forEach((l) => l());
}

/** Reads the count from the engine again (at launch and after clearing data). */
export function refreshBlockedTotal() {
  ShieldEngine.getStatus()
    .then((s) => setBlockedTotal(s.totalBlocked))
    .catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlockedTotal(): number {
  return useSyncExternalStore(subscribe, () => total);
}
