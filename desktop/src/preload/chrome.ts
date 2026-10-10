// Preload script for the window's interface: `window.stillweb` (see ChromeApi).
import { contextBridge, ipcRenderer } from 'electron';

import { CHROME_METHODS } from '../shared/types';

const EVENTS = new Set(['window-state', 'settings', 'engine-status', 'focus-address', 'open-find', 'find-result', 'open-panel', 'downloads', 'bookmarks']);

const api: Record<string, unknown> = {};
for (const method of CHROME_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(`chrome:${method}`, ...args);
}
/** Listens for a message from the main process; returns a function that stops listening. */
api.on = (channel: string, listener: (payload: unknown) => void) => {
  if (!EVENTS.has(channel)) throw new Error(`unknown channel ${channel}`);
  const handler = (_event: unknown, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('stillweb', api);
