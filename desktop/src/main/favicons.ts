// Small copies of sites' icons, kept so the home page can show them without asking each
// site for its icon every time a new tab opens.
import { nativeImage, type Session } from 'electron';

import { jsonFile, type JsonFile } from './store';

type Entry = { icon: string; time: number };

const LIMIT = 400;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** Icons that cannot be made smaller here (SVG, ICO) are kept as they are, up to this size. */
const RAW_LIMIT = 24 * 1024;

let file: JsonFile<Record<string, Entry>> | null = null;
const fetching = new Set<string>();

export function loadFavicons(): void {
  file = jsonFile<Record<string, Entry>>('favicons.json', {}, 8000);
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** The stored icon for a page's site (a data: URL), or null. */
export function iconFor(url: string): string | null {
  const host = hostOf(url);
  return (host && file?.value[host]?.icon) || null;
}

/** A page showed its icon: keep a small copy, unless a recent one is already there. */
export function rememberFavicon(session: Session, pageUrl: string, iconUrl: string): void {
  const host = hostOf(pageUrl);
  if (!host || !file || fetching.has(host)) return;
  const known = file.value[host];
  if (known && Date.now() - known.time < KEEP_MS) return;
  if (iconUrl.startsWith('data:image/')) {
    if (iconUrl.length <= RAW_LIMIT * 1.4) store(host, iconUrl);
    return;
  }
  if (!/^https?:/i.test(iconUrl)) return;
  fetching.add(host);
  void session
    .fetch(iconUrl, { signal: AbortSignal.timeout(8000) })
    .then(async (response) => {
      if (!response.ok) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 512 * 1024) return;
      const image = nativeImage.createFromBuffer(bytes);
      if (!image.isEmpty()) {
        // 64 pixels: sharp at the size the tiles draw it, on any screen.
        const small = image.getSize().width > 64 ? image.resize({ width: 64, height: 64, quality: 'best' }) : image;
        store(host, `data:image/png;base64,${small.toPNG().toString('base64')}`);
      } else if (bytes.length <= RAW_LIMIT) {
        const type = response.headers.get('content-type')?.split(';')[0] || 'image/x-icon';
        if (type.startsWith('image/')) store(host, `data:${type};base64,${bytes.toString('base64')}`);
      }
    })
    .catch(() => {})
    .finally(() => fetching.delete(host));
}

function store(host: string, icon: string): void {
  if (!file) return;
  const all = file.value;
  all[host] = { icon, time: Date.now() };
  const hosts = Object.keys(all);
  if (hosts.length > LIMIT) {
    hosts.sort((a, b) => all[a].time - all[b].time);
    for (const old of hosts.slice(0, hosts.length - LIMIT)) delete all[old];
  }
  file.changed();
}

export function clearFavicons(): void {
  if (!file) return;
  file.value = {};
  file.changed();
}
