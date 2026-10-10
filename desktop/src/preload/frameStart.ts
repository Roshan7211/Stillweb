// Runs first in every page frame, before the page's own scripts: asks the main process what
// applies to this frame (one synchronous question), runs the scriptlets in the page's world,
// and leaves the cosmetic filters where the scripts imported after this one find them.
import { ipcRenderer, webFrame } from 'electron';

import type { FrameStart } from '../shared/types';

type Bridge = { onmessage: ((event: { data: string }) => void) | null; postMessage(payload: string): void };

declare global {
  // Read by web/shieldjs/cosmetic-host.js (its __SHIELD_CONFIG__ placeholder is built to this).
  var __stillwebHostConfig: FrameStart['cosmetic'];
  interface Window {
    /** The transport web/shieldjs/cosmetic-generic.js expects (the same shape as on Android). */
    __shieldBridge?: Bridge;
  }
}

globalThis.__stillwebHostConfig = null;

if (location.protocol === 'http:' || location.protocol === 'https:') {
  let start: FrameStart | null = null;
  try {
    start = ipcRenderer.sendSync('shield:frame-start', location.hostname) as FrameStart;
  } catch {
    // Without an answer the frame simply loads unfiltered.
  }
  if (start) {
    // Scriptlets must see the page's own globals, so they run in its world, not this one.
    if (start.pageScript) void webFrame.executeJavaScript(start.pageScript).catch(() => {});
    globalThis.__stillwebHostConfig = start.cosmetic;
    if (start.generic) {
      const bridge: Bridge = {
        onmessage: null,
        postMessage(payload) {
          void ipcRenderer.invoke('shield:generic', payload).then(
            (reply: string) => bridge.onmessage?.({ data: reply }),
            () => bridge.onmessage?.({ data: '[]' }),
          );
        },
      };
      window.__shieldBridge = bridge;
    }
  }
}
