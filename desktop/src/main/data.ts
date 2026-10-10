// What the browser remembers: history, bookmarks and the privacy report's counters.
import type { Bookmark, HistoryEntry, PrivacyReport } from '../shared/types';
import { jsonFile, type JsonFile } from './store';

const HISTORY_LIMIT = 5000;
const HOST_LIMIT = 400;
const REPORT_DAYS = 14;

type Stats = { total: number; hosts: Record<string, number>; days: Record<string, number> };

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
  historyFile.changed();
}

/** The page's title usually arrives after the visit was recorded. */
export function updateVisitTitle(url: string, title: string): void {
  const list = historyFile.value;
  for (let i = list.length - 1; i >= 0 && i >= list.length - 20; i--) {
    if (list[i].url === url) {
      if (list[i].title !== title) {
        list[i].title = title;
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
  historyFile.changed();
}

export function clearHistory(): void {
  historyFile.value = [];
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
  bookmarkFile.changed();
  for (const listener of bookmarkListeners) listener();
}

export function onBookmarksChanged(listener: () => void): void {
  bookmarkListeners.add(listener);
}

/** History and bookmarks that match what is being typed in the address bar, best first. */
export function localSuggestions(query: string, limit = 5): { kind: 'history' | 'bookmark'; url: string; title: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  const out: { kind: 'history' | 'bookmark'; url: string; title: string }[] = [];
  for (const b of bookmarkFile.value) {
    if (out.length >= limit) return out;
    if (matches(b, words) && !seen.has(b.url)) {
      seen.add(b.url);
      out.push({ kind: 'bookmark', url: b.url, title: b.title });
    }
  }
  const list = historyFile.value;
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    if (matches(list[i], words) && !seen.has(list[i].url)) {
      seen.add(list[i].url);
      out.push({ kind: 'history', url: list[i].url, title: list[i].title });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Privacy report

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
