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
  /** The last press in the page, as its frame reported it: when, and the link under it ('' for none). */
  lastPress: { time: number; href: string } | null;
  /** The user is watching or listening to something on this page (see `watching`). */
  watching: boolean;
  /** Windows stopped on this page, and the address of the last one. */
  popups: { count: number; last: string };
  /** The user agent for this page when it is not the usual one (see userAgentFor). */
  agent: string | null;
};

const pages = new Map<number, PageState>();
/** Hosts where an HTTPS upgrade failed; shared by all tabs until the app quits. */
const httpOnlyHosts = new Set<string>();

/** `--log-shields`: prints every blocked request and every pop-up decision, for looking into a site. */
const LOG = process.argv.includes('--log-shields');
const log = (...parts: unknown[]) => {
  if (LOG) console.log('[shields]', ...parts);
};

/** 'blocked' (webContentsId) when a page's counters change. */
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
    state = { url: 'about:blank', shieldsActive: true, blocked: 0, pendingUpgrade: null, lastGesture: 0, lastPress: null, watching: false, popups: { count: 0, last: '' }, agent: null };
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

export function pageInfo(contents: WebContents): { blocked: number; shieldsActive: boolean; popups: { count: number; last: string } } {
  const state = pageState(contents);
  return { blocked: state.blocked, shieldsActive: state.shieldsActive, popups: state.popups };
}

/** Called for every main-frame load (a reload too): resets the page's counter and its shields state. */
function beginMainFrame(contents: WebContents, url: string): void {
  const state = pageState(contents);
  // Recompute every time: per-site settings may have changed since the last load.
  state.shieldsActive = shieldEngine.shieldsEnabledFor(hostOf(url));
  state.url = url;
  const agent = userAgentFor(url);
  state.agent = agent === browserUserAgent() ? null : agent;
  state.watching = false;
  state.lastPress = null;
  if (state.popups.count !== 0) state.popups = { count: 0, last: '' };
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
  log('blocked', url ?? '(pop-up)');
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

/** Sites (host without www.) the user allowed to open windows; set from the settings. */
let popupSites = new Set<string>();

export function setPopupSites(sites: string[]): void {
  popupSites = new Set(sites.map((site) => site.toLowerCase()));
}

function popupsAllowedOn(pageUrl: string): boolean {
  let host = (hostOf(pageUrl) ?? '').replace(/^www\./, '');
  for (;;) {
    if (popupSites.has(host)) return true;
    const dot = host.indexOf('.');
    if (dot < 0) return false;
    host = host.slice(dot + 1);
  }
}

/** The page is playing sound, or a frame saw a video being watched (see preload/frameStart.ts). */
export function markWatching(contents: WebContents): void {
  pageState(contents).watching = true;
}

/** How long after a window opens its first addresses are still checked (see `PopupGuard`). */
const GUARD_MS = 6000;

/**
 * A window that was let through is watched for a moment: ad windows often open empty, or at
 * an address nobody lists, and only then go where they were meant to. `strict` is set when
 * the page it came from would not have been allowed to open another site directly.
 */
export type PopupGuard = { openerId: number; openerUrl: string; strict: boolean; until: number };

function stopPopup(opener: WebContents | undefined, url: string, why: string): void {
  log('window stopped:', why, url);
  recordBlocked(/^https?:/i.test(url) ? hostOf(url) : null);
  if (!opener || opener.isDestroyed()) return;
  const state = pageState(opener);
  state.blocked++;
  state.popups = { count: state.popups.count + 1, last: /^https?:/i.test(url) ? url : state.popups.last };
  shieldEvents.emit('blocked', opener.id);
}

/**
 * Decides about a window a page wants to open. Stopped are:
 *  - one that no click or key press asked for;
 *  - one whose address the filters block (`$popup` rules, checked as documents);
 *  - on a page where the user is watching video or listening, one to another site that the
 *    press was not a link to. That is how players earn from every click on the video; a real
 *    link, the site's own windows and sites the user allowed still open.
 * Returns null when it is stopped, otherwise how to watch the new window.
 */
export function popupDecision(opener: WebContents, url: string): PopupGuard | null {
  const state = pageState(opener);
  const guard = (strict: boolean): PopupGuard => ({ openerId: opener.id, openerUrl: state.url, strict, until: Date.now() + GUARD_MS });
  if (!state.shieldsActive) return guard(false);
  const web = /^https?:/i.test(url);
  const byUser = hadRecentGesture(opener);
  const press = state.lastPress && Date.now() - state.lastPress.time < 2000 ? state.lastPress : null;
  // The press was on a link to this address (or to its site, for links that pass through a redirect).
  const fromLink = !!press && press.href !== '' && (press.href === url || (web && !shieldEngine.isThirdParty(url, press.href)));
  const strict = shieldEngine.options.blockPopups && state.watching && !fromLink && !popupsAllowedOn(state.url);
  log('window', url, byUser ? 'after a click' : 'no click', fromLink ? 'on a link' : '', state.watching ? 'while watching' : '', 'from', state.url);

  if (web && shieldEngine.check(url, state.url, 'document').action !== 'allow') return stopPopup(opener, url, 'matches a filter'), null;
  if (!byUser && shieldEngine.options.blockPopups) return stopPopup(opener, url, 'no click'), null;
  if (strict && web && shieldEngine.isThirdParty(url, state.url)) return stopPopup(opener, url, 'another site, while watching'), null;
  return guard(strict);
}

/**
 * A new window is going to `url` shortly after it opened. True when it should be closed:
 * the address is filtered, or the window came from a page that may not open other sites.
 */
export function guardedNavigationBlocked(guard: PopupGuard, opened: WebContents, url: string): boolean {
  if (Date.now() > guard.until || !/^https?:/i.test(url)) return false;
  // Once the user has done something in the new window it is theirs.
  if (pageState(opened).lastGesture > 0) return false;
  const filtered = shieldEngine.check(url, guard.openerUrl, 'document').action !== 'allow';
  const offSite = guard.strict && shieldEngine.isThirdParty(url, guard.openerUrl);
  if (!filtered && !offSite) return false;
  const opener = [...openers].find((contents) => contents.id === guard.openerId);
  stopPopup(opener, url, filtered ? 'matches a filter, after opening' : 'another site, after opening');
  return true;
}

/** Web contents that have opened windows, to find the page a stopped window is counted on. */
const openers = new Set<WebContents>();

export function rememberOpener(contents: WebContents): void {
  if (openers.has(contents)) return;
  openers.add(contents);
  contents.once('destroyed', () => openers.delete(contents));
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
    // The request for a page itself is on its way before the tab's own setting can change
    // (see userAgentFor and the tab's did-start-navigation), so it is set here.
    const state = details.webContents ? pages.get(details.webContents.id) : null;
    if (details.resourceType === 'mainFrame') headers['User-Agent'] = userAgentFor(details.url);
    else if (state?.agent) headers['User-Agent'] = state.agent;
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

  // Every real press in a page: the link under it (if any), and whether a video is being
  // watched in that frame. Pop-up decisions use both.
  ipcMain.on('shield:press', (event, href: unknown, watching: unknown) => {
    const state = pageState(event.sender);
    state.lastPress = { time: Date.now(), href: typeof href === 'string' ? href.slice(0, 4000) : '' };
    if (watching === true) state.watching = true;
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
  baseAgent ??= app.userAgentFallback.replace(/\s(Electron|stillweb-desktop|Stillweb)\/\S+/gi, '');
  return baseAgent;
}

let baseAgent: string | null = null;

/**
 * Sites that show the user a list of the browsers they are signed in from. Everywhere else
 * the app says it is Chrome, like other Chromium browsers do: sites refuse browsers they do
 * not know, and a name only a few people's browser sends makes those people easy to follow
 * around the web. On these sites the user is signed in anyway, and would rather see
 * "Stillweb" than "Chrome" in that list, so the name is added the way browsers add theirs.
 */
export const NAMED_ON = ['web.telegram.org'];

/** The user agent for a page at `url`. */
export function userAgentFor(url: string): string {
  const host = hostOf(url);
  const base = browserUserAgent();
  return host && NAMED_ON.some((site) => host === site || host.endsWith(`.${site}`)) ? `${base} Stillweb/${app.getVersion()}` : base;
}
