// Which sites may start playing sound on their own. As in other browsers, a page cannot
// start sound until the user has used it; the exception is a site where the user has played
// media before, so a video link pasted into the address bar starts like one that was clicked.
import { jsonFile, type JsonFile } from './store';

/**
 * Sites that are about playing media, allowed from the first visit (other browsers ship a
 * list like this too). Everything else is learned from what the user plays.
 */
const PRELOADED = ['youtube.com', 'vimeo.com', 'twitch.tv', 'dailymotion.com', 'soundcloud.com'];
const LIMIT = 300;

let file: JsonFile<string[]> | null = null;

export function loadMediaSites(): void {
  file = jsonFile<string[]>('media-sites.json', []);
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

const within = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

export function allowsAutoplay(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return PRELOADED.some((site) => within(host, site)) || (file?.value.some((site) => within(host, site)) ?? false);
}

/** The user has listened to this site for a while. */
export function rememberMediaSite(url: string): void {
  const host = hostOf(url);
  if (!host || !file || allowsAutoplay(url)) return;
  file.value = [...file.value, host].slice(-LIMIT);
  file.changed();
}

export function clearMediaSites(): void {
  if (!file) return;
  file.value = [];
  file.changed();
}
