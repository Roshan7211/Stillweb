// What the browser remembers: history, bookmarks and the privacy report's counters.
import type { Bookmark, HistoryEntry, PrivacyReport } from '../shared/types';
import { jsonFile, type JsonFile } from './store';

const HISTORY_LIMIT = 5000;
const HOST_LIMIT = 400;
const REPORT_DAYS = 14;

type Stats = { total: number; hosts: Record<string, number>; days: Record<string, number>; upgrades?: number };

let historyFile: JsonFile<HistoryEntry[]>;
let bookmarkFile: JsonFile<Bookmark[]>;
let statsFile: JsonFile<Stats>;
/** How many hosts the stats hold (kept here so a blocked request never has to count them). */
let hostCount = 0;
const bookmarkListeners = new Set<() => void>();

export function loadData(): void {
  historyFile = jsonFile<HistoryEntry[]>('history.json', [], 3000);
  bookmarkFile = jsonFile<Bookmark[]>('bookmarks.json', []);
  statsFile = jsonFile<Stats>('stats.json', { total: 0, hosts: {}, days: {} }, 5000);
  // Whatever a damaged file holds, only well-formed entries are kept.
  const text = (value: unknown): value is string => typeof value === 'string';
  historyFile.value = historyFile.value.filter((e) => e && text(e.url) && text(e.title) && typeof e.time === 'number');
  bookmarkFile.value = bookmarkFile.value.filter((b) => b && text(b.url) && text(b.title));
  const stats = statsFile.value;
  if (typeof stats.total !== 'number') stats.total = 0;
  if (typeof stats.hosts !== 'object' || stats.hosts === null) stats.hosts = {};
  if (typeof stats.days !== 'object' || stats.days === null) stats.days = {};
  hostCount = Object.keys(statsFile.value.hosts).length;
}

function localDay(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// History

/** Adds a visit; loading the same address again right away only refreshes its time and title. */
export function recordVisit(url: string, title: string): void {
  if (!/^https?:/i.test(url)) return;
  const list = historyFile.value;
  const last = list[list.length - 1];
  if (last && last.url === url) {
    last.time = Date.now();
    if (title) last.title = title;
  } else {
    list.push({ url, title, time: Date.now() });
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  }
  forgetUsage();
  historyFile.changed();
}

/** The page's title usually arrives after the visit was recorded. */
export function updateVisitTitle(url: string, title: string): void {
  const list = historyFile.value;
  for (let i = list.length - 1; i >= 0 && i >= list.length - 20; i--) {
    if (list[i].url === url) {
      if (list[i].title !== title) {
        list[i].title = title;
        forgetUsage();
        historyFile.changed();
      }
      return;
    }
  }
}

function matches(entry: { url: string; title: string }, words: string[]): boolean {
  const text = `${entry.title} ${entry.url}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Newest first; `query` filters by words in the title or address. */
export function queryHistory(query: string, limit = 300): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: HistoryEntry[] = [];
  const list = historyFile.value;
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    if (!words.length || matches(list[i], words)) out.push(list[i]);
  }
  return out;
}

export function removeHistory(url: string, time: number): void {
  historyFile.value = historyFile.value.filter((e) => !(e.url === url && e.time === time));
  forgetUsage();
  historyFile.changed();
}

export function clearHistory(): void {
  historyFile.value = [];
  forgetUsage();
  historyFile.changed();
}

/** The sites visited most, for the new tab page. One entry per site: its most visited page. */
export function topSites(limit = 8): { url: string; title: string }[] {
  const sites = new Map<string, { count: number; pages: Map<string, { count: number; title: string }> }>();
  for (const entry of historyFile.value) {
    let host: string;
    try {
      host = new URL(entry.url).host.replace(/^www\./, '');
    } catch {
      continue;
    }
    const site = sites.get(host) ?? { count: 0, pages: new Map() };
    site.count++;
    const page = site.pages.get(entry.url) ?? { count: 0, title: entry.title };
    page.count++;
    if (entry.title) page.title = entry.title;
    site.pages.set(entry.url, page);
    sites.set(host, site);
  }
  return [...sites.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([host, site]) => {
      const [url, page] = [...site.pages.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      return { url, title: page.title || host };
    });
}

// ---------------------------------------------------------------------------
// Bookmarks

export function getBookmarks(): Bookmark[] {
  return bookmarkFile.value;
}

export function isBookmarked(url: string): boolean {
  return bookmarkFile.value.some((b) => b.url === url);
}

export function setBookmarked(url: string, title: string, bookmarked: boolean): void {
  const without = bookmarkFile.value.filter((b) => b.url !== url);
  bookmarkFile.value = bookmarked ? [...without, { url, title: title || url, added: Date.now() }] : without;
  forgetUsage();
  bookmarkFile.changed();
  for (const listener of bookmarkListeners) listener();
}

export function onBookmarksChanged(listener: () => void): void {
  bookmarkListeners.add(listener);
}

// ---------------------------------------------------------------------------
// What the user goes to, and how often: for suggestions and for completing an address.

type PageUse = { url: string; title: string; count: number; last: number; bookmarked: boolean };
type SiteUse = { host: string; origin: string; count: number; last: number; bookmarked: boolean };

/** Built from history and bookmarks when first needed, and again after either has changed. */
let usage: { pages: PageUse[]; sites: SiteUse[] } | null = null;

function forgetUsage(): void {
  usage = null;
}

function buildUsage(): { pages: PageUse[]; sites: SiteUse[] } {
  const pages = new Map<string, PageUse>();
  const sites = new Map<string, SiteUse & { origins: Map<string, number> }>();
  const see = (url: string, title: string, time: number, bookmarked: boolean) => {
    const page = pages.get(url) ?? { url, title, count: 0, last: 0, bookmarked: false };
    if (!bookmarked) page.count++;
    if (title) page.title = title;
    page.last = Math.max(page.last, time);
    page.bookmarked ||= bookmarked;
    pages.set(url, page);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) return;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const site = sites.get(host) ?? { host, origin: parsed.origin, count: 0, last: 0, bookmarked: false, origins: new Map() };
    if (!bookmarked) site.count++;
    site.last = Math.max(site.last, time);
    site.bookmarked ||= bookmarked;
    site.origins.set(parsed.origin, (site.origins.get(parsed.origin) ?? 0) + 1);
    sites.set(host, site);
  };
  for (const entry of historyFile.value) see(entry.url, entry.title, entry.time, false);
  for (const bookmark of bookmarkFile.value) see(bookmark.url, bookmark.title, bookmark.added ?? 0, true);
  return {
    pages: [...pages.values()],
    sites: [...sites.values()].map(({ origins, ...site }) => ({
      ...site,
      // The form of the address the user really goes to (with or without www, http or https).
      origin: [...origins.entries()].sort((x, y) => y[1] - x[1])[0][0],
    })),
  };
}

/** How much a page or site is "the user's": visits count most, a bookmark and a recent visit add to it. */
function weight(use: { count: number; last: number; bookmarked: boolean }): number {
  const days = (Date.now() - use.last) / (24 * 60 * 60 * 1000);
  return use.count + (use.bookmarked ? 4 : 0) + (days < 1 ? 3 : days < 7 ? 2 : days < 30 ? 1 : 0);
}

/** History and bookmarks that match what is being typed in the address bar, most used first. */
export function localSuggestions(query: string, limit = 5): { kind: 'history' | 'bookmark'; url: string; title: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  usage ??= buildUsage();
  const first = words[0];
  return usage.pages
    .filter((page) => matches(page, words))
    .map((page) => {
      // A page whose address starts with what was typed is more likely meant than one that
      // merely mentions it.
      const bare = page.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
      return { page, score: weight(page) + (bare.startsWith(first) ? 6 : 0) };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ page }) => ({ kind: page.bookmarked ? ('bookmark' as const) : ('history' as const), url: page.url, title: page.title }));
}

/**
 * The site the user most likely means by the first letters of an address: "you" becomes the
 * site they visit most whose name starts that way. Only a site they have used more than once
 * (or bookmarked) is offered, and only for something that could be the start of a site's name.
 */
export function completeSite(typed: string): { text: string; url: string } | null {
  const start = typed.trim().toLowerCase();
  if (!start || /[\s/?#@]/.test(start) || start.includes('://')) return null;
  usage ??= buildUsage();
  let best: SiteUse | null = null;
  let bestText = '';
  for (const site of usage.sites) {
    if (site.count < 2 && !site.bookmarked) continue;
    // Typed with or without "www.", as the user prefers.
    const text = site.host.startsWith(start) ? site.host : `www.${site.host}`.startsWith(start) && start.length > 3 ? `www.${site.host}` : '';
    if (!text) continue;
    if (!best || weight(site) > weight(best)) {
      best = site;
      bestText = text;
    }
  }
  return best ? { text: bestText, url: `${best.origin}/` } : null;
}

// ---------------------------------------------------------------------------
// Privacy report

/** A page was opened over a secure connection because the app asked for it. */
export function recordUpgrade(): void {
  statsFile.value.upgrades = (statsFile.value.upgrades ?? 0) + 1;
  statsFile.changed();
}

export function totalUpgrades(): number {
  return statsFile.value.upgrades ?? 0;
}

export function totalBlocked(): number {
  return statsFile.value.total;
}

export function recordBlocked(host: string | null): void {
  const stats = statsFile.value;
  stats.total++;
  const day = localDay(Date.now());
  if (!(day in stats.days)) {
    // A new day: days the report no longer shows are dropped.
    const oldest = localDay(Date.now() - REPORT_DAYS * 24 * 60 * 60 * 1000);
    for (const key of Object.keys(stats.days)) if (key < oldest) delete stats.days[key];
  }
  stats.days[day] = (stats.days[day] ?? 0) + 1;
  if (host) {
    if (!(host in stats.hosts)) hostCount++;
    stats.hosts[host] = (stats.hosts[host] ?? 0) + 1;
    // Keep the table small: when it outgrows the limit, drop the hosts seen least.
    if (hostCount > HOST_LIMIT * 1.5) {
      const names = Object.keys(stats.hosts).sort((a, b) => stats.hosts[b] - stats.hosts[a]);
      for (const name of names.slice(HOST_LIMIT)) delete stats.hosts[name];
      hostCount = HOST_LIMIT;
    }
  }
  statsFile.changed();
}

export function privacyReport(): PrivacyReport {
  const stats = statsFile.value;
  const days: PrivacyReport['days'] = [];
  for (let i = REPORT_DAYS - 1; i >= 0; i--) {
    const day = localDay(Date.now() - i * 24 * 60 * 60 * 1000);
    days.push({ day, count: stats.days[day] ?? 0 });
  }
  const hosts = Object.entries(stats.hosts)
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  return { totalBlocked: stats.total, hosts, days };
}

export function resetPrivacyReport(): void {
  statsFile.value = { total: 0, hosts: {}, days: {} };
  hostCount = 0;
  statsFile.changed();
}
