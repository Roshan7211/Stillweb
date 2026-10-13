// Small pictures of the pages the user visits, for the home page's "often visited" cards.
// One per site, taken a moment after a page has loaded in the tab in front, and kept until
// browsing data is cleared. Never taken in private windows.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, type Session, type WebContents } from 'electron';

import { dataPath, jsonFile, type JsonFile } from './store';

type Entry = { file: string; time: number };

const LIMIT = 80;
/** A site's picture is taken again when it is older than this. */
const REFRESH_MS = 12 * 60 * 60 * 1000;
const WIDTH = 560;

let index: JsonFile<Record<string, Entry>> | null = null;
const dir = () => dataPath('thumbnails');

export function loadThumbnails(): void {
  index = jsonFile<Record<string, Entry>>('thumbnails.json', {}, 4000);
  for (const [host, entry] of Object.entries(index.value)) {
    if (!entry || typeof entry.file !== 'string' || !/^[0-9a-f]{16}\.jpg$/.test(entry.file) || typeof entry.time !== 'number') delete index.value[host];
  }
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** The stored picture for a page's site, as an address the interface can show, or null. */
export function thumbnailFor(url: string): string | null {
  const host = hostOf(url);
  const entry = host ? index?.value[host] : undefined;
  return entry ? `${pathToFileURL(path.join(dir(), entry.file)).href}?t=${entry.time}` : null;
}

export function wantsThumbnail(url: string): boolean {
  const host = hostOf(url);
  if (!host || !index) return false;
  const entry = index.value[host];
  return !entry || Date.now() - entry.time > REFRESH_MS;
}

/** Takes the picture of what `contents` shows now and stores it for the site of `url`. */
export async function captureThumbnail(contents: WebContents, url: string): Promise<void> {
  const host = hostOf(url);
  if (!host || !index) return;
  // A page that asks for a password is a sign-in page, and what follows one is private:
  // neither belongs on the home page.
  const signIn = await contents.executeJavaScript('!!document.querySelector("input[type=password]")').catch(() => true);
  if (signIn || contents.isDestroyed()) return;
  const image = await contents.capturePage();
  if (image.isEmpty() || contents.isDestroyed()) return;
  const file = `${createHash('sha1').update(host).digest('hex').slice(0, 16)}.jpg`;
  await fs.promises.mkdir(dir(), { recursive: true });
  await fs.promises.writeFile(path.join(dir(), file), image.resize({ width: WIDTH, quality: 'best' }).toJPEG(80));
  const all = index.value;
  all[host] = { file, time: Date.now() };
  const hosts = Object.keys(all);
  if (hosts.length > LIMIT) {
    hosts.sort((a, b) => all[a].time - all[b].time);
    for (const old of hosts.slice(0, hosts.length - LIMIT)) {
      void fs.promises.rm(path.join(dir(), all[old].file), { force: true });
      delete all[old];
    }
  }
  index.changed();
}

// ---------------------------------------------------------------------------
// Pictures for sites that have none yet (visited before pictures were kept): the page is
// opened out of sight, one site at a time, and its picture taken.

const queue: string[] = [];
/** Sites already tried since the app started, whether or not it worked. */
const tried = new Set<string>();
const hidden = new Set<number>();
let working = false;
let onStored: (() => void) | null = null;

/** Whether these web contents are one of the out-of-sight pages (they may not download or ask for anything). */
export function isHiddenPage(contents: WebContents | null | undefined): boolean {
  return !!contents && hidden.has(contents.id);
}

/** `stored` is called each time a picture has arrived. */
export function wantThumbnails(session: Session, urls: string[], stored: () => void): void {
  onStored = stored;
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || tried.has(host) || index?.value[host]) continue;
    tried.add(host);
    queue.push(url);
  }
  if (!working && queue.length) void work(session);
}

async function work(session: Session): Promise<void> {
  working = true;
  for (let url = queue.shift(); url; url = queue.shift()) {
    await takeHidden(session, url).catch(() => {});
  }
  working = false;
}

async function takeHidden(session: Session, url: string): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    // Nothing a hidden page does may reach the user: no alert boxes, no sound, no windows.
    webPreferences: { session, sandbox: true, contextIsolation: true, offscreen: true, disableDialogs: true, autoplayPolicy: 'document-user-activation-required' },
  });
  current = window;
  const contents = window.webContents;
  hidden.add(contents.id);
  const id = contents.id;
  try {
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    let failed = false;
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) failed = true;
    });
    await Promise.race([contents.loadURL(url), new Promise((resolve) => setTimeout(resolve, 15000))]).catch(() => {
      failed = true;
    });
    if (failed || window.isDestroyed()) return;
    // A moment for pictures and fonts to arrive.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    if (window.isDestroyed() || contents.isDestroyed() || !/^https?:/i.test(contents.getURL())) return;
    await captureThumbnail(contents, url);
    onStored?.();
  } finally {
    hidden.delete(id);
    if (current === window) current = null;
    if (!window.isDestroyed()) window.destroy();
  }
}

let current: BrowserWindow | null = null;

/**
 * The last browser window closed: nothing is fetched for a home page nobody can see, and a
 * hidden page must not keep the app from quitting.
 */
export function stopThumbnails(): void {
  queue.length = 0;
  if (current && !current.isDestroyed()) current.destroy();
  current = null;
}

export function clearThumbnails(): void {
  if (index) {
    index.value = {};
    index.changed();
  }
  void fs.promises.rm(dir(), { recursive: true, force: true });
}
