// Blocking for a browsing session: every request is checked against adblock-rust, and each
// frame gets its cosmetic filters and scriptlets before the page's own scripts run (the
// desktop counterpart of ShieldWebView.kt and RequestSupport.kt).
import { app, ipcMain, protocol, type Session, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import privacyScript from '../../../native/shield-webview/web/shieldjs/privacy.js?text';
import chromeObjectScript from './chromeObject.js?text';
import type { FrameStart } from '../shared/types';
import { recordBlocked } from './data';
import { shieldEngine } from './engine/shieldEngine';

/** Serves `$redirect` resources. A scheme of the app's own, so a page's CSP cannot refuse them. */
const RESOURCE_SCHEME = 'stillweb-res';

/** Before the app is ready: schemes can only be declared then. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: RESOURCE_SCHEME, privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/** Electron's resource types as adblock-rust's request types. */
const REQUEST_TYPES: Record<string, string> = {
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

type PageState = {
  /** The page in the tab (the top frame), which requests are checked against. */
  url: string;
  shieldsActive: boolean;
  blocked: number;
  /** The https address a main-frame request was upgraded to, until it loads or fails. */
  pendingUpgrade: string | null;
  /** When the user last clicked or typed in the page: pop-ups are allowed just after. */
  lastGesture: number;
};

const pages = new Map<number, PageState>();
/** Hosts where an HTTPS upgrade failed; shared by all tabs until the app quits. */
const httpOnlyHosts = new Set<string>();

/** 'blocked' (webContentsId) when a page's counter changes; 'popup-blocked' (webContentsId, url). */
export const shieldEvents = new EventEmitter();

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function pageState(contents: WebContents): PageState {
  let state = pages.get(contents.id);
  if (!state) {
    state = { url: 'about:blank', shieldsActive: true, blocked: 0, pendingUpgrade: null, lastGesture: 0 };
    pages.set(contents.id, state);
    const id = contents.id;
    contents.once('destroyed', () => pages.delete(id));
    // Clicks and key presses, for telling a pop-up the user asked for from one a script opened.
    contents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'mouseUp' || input.type === 'keyDown' || input.type === 'touchEnd') {
        state!.lastGesture = Date.now();
      }
    });
  }
  return state;
}

export function pageInfo(contents: WebContents): { blocked: number; shieldsActive: boolean } {
  const state = pageState(contents);
  return { blocked: state.blocked, shieldsActive: state.shieldsActive };
}

/** Called for every main-frame load (a reload too): resets the page's counter and its shields state. */
function beginMainFrame(contents: WebContents, url: string): void {
  const state = pageState(contents);
  // Recompute every time: per-site settings may have changed since the last load.
  state.shieldsActive = shieldEngine.shieldsEnabledFor(hostOf(url));
  state.url = url;
  if (state.blocked !== 0) {
    state.blocked = 0;
    shieldEvents.emit('blocked', contents.id);
  }
}

/**
 * The page that is really showing once loading has stopped. A navigation that was asked for
 * but never arrived (a download, a stopped load) must not leave the tab checked against it.
 */
export function pageCommitted(contents: WebContents, url: string): void {
  const state = pageState(contents);
  if (state.url === url || !/^https?:/i.test(url)) return;
  state.url = url;
  state.shieldsActive = shieldEngine.shieldsEnabledFor(hostOf(url));
}

/** After the user turned shields on or off for a site: the open page follows on its next load. */
export function refreshShieldsState(contents: WebContents): void {
  const state = pageState(contents);
  state.shieldsActive = shieldEngine.shieldsEnabledFor(hostOf(state.url));
}

function countBlocked(contents: WebContents | undefined, url: string | null): void {
  recordBlocked(url ? hostOf(url) : null);
  if (!contents) return;
  pageState(contents).blocked++;
  shieldEvents.emit('blocked', contents.id);
}

// ---------------------------------------------------------------------------
// HTTPS upgrades

function upgradable(url: string): boolean {
  if (!shieldEngine.options.httpsUpgrade || !/^http:\/\//i.test(url)) return false;
  const host = hostOf(url);
  if (!host) return false;
  return !(httpOnlyHosts.has(host) || host === 'localhost' || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.includes(':'));
}

/** Chromium's codes for: network changed, name not resolved, internet disconnected. */
const NETWORK_DOWN = new Set([-21, -105, -106]);

/**
 * A main-frame load failed. When it was an address this app upgraded to https, returns the
 * original http address to load instead (and remembers that the host has no https).
 */
export function httpFallback(contents: WebContents, failedUrl: string, errorCode: number): string | null {
  const state = pageState(contents);
  if (!state.pendingUpgrade || hostOf(state.pendingUpgrade) !== hostOf(failedUrl)) return null;
  state.pendingUpgrade = null;
  // No network, or no such site: that says nothing about https, and http would fail too.
  if (NETWORK_DOWN.has(errorCode)) return null;
  const host = hostOf(failedUrl);
  if (host) httpOnlyHosts.add(host);
  return failedUrl.replace(/^https:/i, 'http:');
}

export function upgradeSettled(contents: WebContents): void {
  pageState(contents).pendingUpgrade = null;
}

/** Whether the user clicked or typed in the page a moment ago (so what happens now is theirs). */
export function hadRecentGesture(contents: WebContents): boolean {
  // The same five seconds Chromium gives a click before it stops counting.
  return Date.now() - pageState(contents).lastGesture < 5000;
}

// ---------------------------------------------------------------------------
// Pop-ups

/**
 * Whether a window a page wants to open should be stopped: one that no click or key press
 * asked for, or one whose address the filters block (`$popup` rules, checked as documents).
 */
export function shouldBlockPopup(opener: WebContents, url: string): boolean {
  const state = pageState(opener);
  if (!state.shieldsActive) return false;
  const byUser = hadRecentGesture(opener);
  const isAd = /^https?:/i.test(url) && shieldEngine.check(url, state.url, 'document').action !== 'allow';
  if ((!byUser && shieldEngine.options.blockPopups) || isAd) {
    countBlocked(opener, isAd ? url : null);
    shieldEvents.emit('popup-blocked', opener.id, url);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// `$redirect` resources

type Resource = { mime: string; body: Buffer };
const resources = new Map<string, Resource>();

/** Keeps the resource behind a data: URL from adblock-rust; returns the address that serves it. */
function resourceUrl(dataUrl: string): string | null {
  const id = createHash('sha1').update(dataUrl).digest('hex').slice(0, 24);
  if (!resources.has(id)) {
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || comma < 0) return null;
    const meta = dataUrl.slice(5, comma);
    const payload = dataUrl.slice(comma + 1);
    const body = meta.endsWith(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (resources.size >= 128) resources.delete(resources.keys().next().value as string);
    resources.set(id, { mime: meta.split(';')[0] || 'text/plain', body });
  }
  return `${RESOURCE_SCHEME}://r/${id}`;
}

// ---------------------------------------------------------------------------

function hasHeader(headers: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === name);
}

/** Turns on blocking for a session; every tab that uses the session is covered. */
export function attachShields(session: Session): void {
  session.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'preload-page.js') });

  session.protocol.handle(RESOURCE_SCHEME, (request) => {
    const resource = resources.get(new URL(request.url).pathname.slice(1));
    if (!resource) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(resource.body), {
      headers: { 'Content-Type': resource.mime, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  });

  session.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    const contents = details.webContents;
    if (!/^(https?|wss?):/i.test(url)) return callback({});

    if (details.resourceType === 'mainFrame') {
      if (!contents) return callback({});
      const state = pageState(contents);
      // A server sending us from https back to http on the same host: respect it, don't loop.
      if (state.pendingUpgrade && /^http:/i.test(url) && hostOf(state.pendingUpgrade) === hostOf(url)) {
        const host = hostOf(url);
        if (host) httpOnlyHosts.add(host);
        state.pendingUpgrade = null;
      } else if (details.method === 'GET' && upgradable(url)) {
        const upgraded = url.replace(/^http:/i, 'https:');
        state.pendingUpgrade = upgraded;
        beginMainFrame(contents, upgraded);
        return callback({ redirectURL: upgraded });
      }
      beginMainFrame(contents, url);
      return callback({});
    }

    // Requests without a tab (a service worker's own) are checked against the site that made them.
    const state = contents ? pageState(contents) : null;
    const source = state ? state.url : (details.initiatorOrigin ?? details.referrer ?? '');
    const active = state ? state.shieldsActive : shieldEngine.shieldsEnabledFor(hostOf(source));
    if (!active || !shieldEngine.isReady || !/^https?:/i.test(source)) return callback({});

    const verdict = shieldEngine.check(url, source, REQUEST_TYPES[details.resourceType] ?? 'other');
    if (verdict.action === 'allow') return callback({});
    countBlocked(contents, url);
    if (verdict.action === 'redirect') {
      const redirectURL = resourceUrl(verdict.dataUrl);
      if (redirectURL) return callback({ redirectURL });
    }
    callback({ cancel: true });
  });

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    // Global Privacy Control: an opt-out of the sale and sharing of personal data.
    headers['Sec-GPC'] = '1';
    const state = details.webContents ? pages.get(details.webContents.id) : null;
    if (state?.shieldsActive && shieldEngine.options.blockThirdPartyCookies && details.resourceType !== 'mainFrame') {
      const cookie = hasHeader(headers, 'cookie');
      if (cookie && shieldEngine.isThirdParty(details.url, state.url)) delete headers[cookie];
    }
    callback({ requestHeaders: headers });
  });

  session.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    const state = details.webContents ? pages.get(details.webContents.id) : null;
    if (headers && state?.shieldsActive && shieldEngine.options.blockThirdPartyCookies && details.resourceType !== 'mainFrame') {
      const setCookie = hasHeader(headers, 'set-cookie');
      if (setCookie && shieldEngine.isThirdParty(details.url, state.url)) {
        delete headers[setCookie];
        return callback({ responseHeaders: headers });
      }
    }
    callback({});
  });
}

// ---------------------------------------------------------------------------
// Frames: cosmetic filters and scriptlets (asked for by src/preload/frameStart.ts)

/**
 * uBlock Origin's scriptlets read settings from a `scriptletGlobals` object that the code
 * injecting them has to provide; without it every scriptlet stops with a ReferenceError
 * (which its own try/catch hides). Empty is right here: no logger, no extension resources.
 */
function wrapScriptlets(scriptlets: string): string {
  return `(function(){\nconst scriptletGlobals = {};\n${scriptlets}\n})();`;
}

/** What every page gets, whether or not Shields are on: see the two files. */
const EVERY_PAGE = `${chromeObjectScript}\n${privacyScript}`;
const NOTHING: FrameStart = { pageScript: EVERY_PAGE, cosmetic: null, generic: false };

function frameStart(contents: WebContents, frameHost: string): FrameStart {
  const state = pages.get(contents.id);
  // Shields are off for the page: its frames are left alone too.
  if ((state && !state.shieldsActive) || !shieldEngine.shieldsEnabledFor(frameHost)) return NOTHING;
  const found = shieldEngine.cosmeticResources(frameHost);
  if (!found) return NOTHING;
  const cosmetic = shieldEngine.options.cosmeticFiltering;
  const hasRules = cosmetic && (found.hide_selectors.length > 0 || found.procedural_actions.length > 0);
  return {
    pageScript: found.injected_script.trim() ? `${EVERY_PAGE}\n${wrapScriptlets(found.injected_script)}` : EVERY_PAGE,
    cosmetic: hasRules ? { hide: found.hide_selectors, procedural: found.procedural_actions } : null,
    generic: cosmetic && !found.generichide,
  };
}

const strings = (value: unknown, limit: number): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length < 200).slice(0, limit) : [];

/** Once, at startup: answers for the preload script that runs in every page frame. */
export function registerFrameHandlers(): void {
  ipcMain.on('shield:frame-start', (event, host: unknown) => {
    try {
      event.returnValue = typeof host === 'string' && host.length < 256 ? frameStart(event.sender, host.toLowerCase()) : NOTHING;
    } catch {
      event.returnValue = NOTHING;
    }
  });

  // Generic (class and id) hiding: the frame reports new class names and ids, and gets the
  // selectors that apply. "null" tells it to stop asking.
  ipcMain.handle('shield:generic', (event, payload: unknown): string => {
    const host = hostOf(event.senderFrame?.url ?? '');
    if (!host || typeof payload !== 'string' || payload.length > 400_000) return '[]';
    const state = pages.get(event.sender.id);
    if (!shieldEngine.options.cosmeticFiltering || (state && !state.shieldsActive) || !shieldEngine.shieldsEnabledFor(host)) return 'null';
    const found = shieldEngine.cosmeticResources(host);
    if (!found || found.generichide) return 'null';
    let query: { classes?: unknown; ids?: unknown };
    try {
      query = JSON.parse(payload) as typeof query;
    } catch {
      return '[]';
    }
    return shieldEngine.hiddenSelectors(strings(query.classes, 5000), strings(query.ids, 5000), found.exceptions);
  });
}

/** A browser's user agent, without the words that tell sites this is an embedded one. */
export function browserUserAgent(): string {
  return app.userAgentFallback.replace(/\s(Electron|stillweb-desktop|Stillweb)\/\S+/gi, '');
}
