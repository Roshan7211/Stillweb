// Small pictures of the pages the user visits, for the home page's "often visited" cards.
// One per site, taken a moment after a page has loaded in the tab in front, and kept until
// browsing data is cleared. Never taken in private windows.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WebContents } from 'electron';

import { dataPath, jsonFile, type JsonFile } from './store';

type Entry = { file: string; time: number };

const LIMIT = 80;
/** A site's picture is taken again when it is older than this. */
const REFRESH_MS = 12 * 60 * 60 * 1000;
const WIDTH = 480;

let index: JsonFile<Record<string, Entry>> | null = null;
const dir = () => dataPath('thumbnails');

export function loadThumbnails(): void {
  index = jsonFile<Record<string, Entry>>('thumbnails.json', {}, 4000);
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
  const image = await contents.capturePage();
  if (image.isEmpty() || contents.isDestroyed()) return;
  const file = `${createHash('sha1').update(host).digest('hex').slice(0, 16)}.jpg`;
  await fs.promises.mkdir(dir(), { recursive: true });
  await fs.promises.writeFile(path.join(dir(), file), image.resize({ width: WIDTH, quality: 'good' }).toJPEG(72));
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

export function clearThumbnails(): void {
  if (index) {
    index.value = {};
    index.changed();
  }
  void fs.promises.rm(dir(), { recursive: true, force: true });
}
