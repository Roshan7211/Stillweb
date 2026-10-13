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

/**
 * Is the user watching a video in this frame? A long video, or one playing with sound, that
 * is big enough to be a player (not a looping background or a thumbnail preview).
 */
function watchingVideo(): boolean {
  const videos = document.getElementsByTagName('video');
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (!(video.duration > 120 || (!video.paused && !video.muted))) continue;
    const box = video.getBoundingClientRect();
    if (box.width >= 300 && box.height >= 150) return true;
  }
  return false;
}

/** The address of the link an event happened on, or ''. */
function linkUnder(event: Event): string {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) return node.href;
  }
  return '';
}

if (location.protocol === 'http:' || location.protocol === 'https:') {
  let start: FrameStart | null = null;
  try {
    start = ipcRenderer.sendSync('shield:frame-start', location.hostname) as FrameStart;
  } catch {
    // Without an answer the frame simply loads unfiltered.
  }
  // Tell the main process about every real press before the page's own handlers run. A page
  // cannot fake these: this world is not reachable from it, and only real input is trusted.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.isTrusted) ipcRenderer.send('shield:press', linkUnder(event), watchingVideo());
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && event.key === 'Enter') ipcRenderer.send('shield:press', linkUnder(event), watchingVideo());
    },
    true,
  );

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
