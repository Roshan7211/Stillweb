import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { displayUrl, hostOf, isBlank } from './url';

/** `vault`: saved from a private tab into the Face ID-locked vault (Stillweb Plus). */
export type Bookmark = { id: string; url: string; title: string; createdAt: number; vault?: boolean };
/** `visits`: how many times the page was opened (absent in history saved before it was counted: once). */
export type HistoryEntry = { url: string; title: string; visitedAt: number; visits?: number };
export type DownloadRecord = {
  id: string;
  /** Android DownloadManager id; absent when the platform handled it (iOS). */
  nativeId?: number;
  url: string;
  fileName: string;
  filePath?: string;
  startedAt: number;
  /** A private tab's download kept in the vault (iOS). */
  vault?: boolean;
};

const KEYS = { bookmarks: 'library.bookmarks', history: 'library.history', downloads: 'library.downloads' };
const MAX_HISTORY = 2000;

/** Changes to the library; their identities never change, so using them doesn't re-render. */
type LibraryActions = {
  /** Adds (to the vault when `vault`) or removes the bookmark for this page. */
  toggleBookmark: (url: string, title: string, vault?: boolean) => void;
  removeBookmark: (id: string) => void;
  addVisit: (url: string, title: string) => void;
  updateVisitTitle: (url: string, title: string) => void;
  removeHistory: (url: string) => void;
  clearHistory: () => void;
  addDownload: (record: Omit<DownloadRecord, 'id' | 'startedAt'>) => void;
  removeDownload: (id: string) => void;
};

type LibraryValue = LibraryActions & {
  /** Normal bookmarks; the vault's are only in `vaultBookmarks`. */
  bookmarks: Bookmark[];
  vaultBookmarks: Bookmark[];
  history: HistoryEntry[];
  /** Normal downloads; the vault's are only in `vaultDownloads`. */
  downloads: DownloadRecord[];
  vaultDownloads: DownloadRecord[];
  /** Bookmarked anywhere (normal or vault). */
  isBookmarked: (url: string) => boolean;
  /** Sites whose name starts with the text first, then other bookmark and history matches. */
  suggest: (query: string, limit?: number) => { url: string; title: string; kind: 'bookmark' | 'history' }[];
  /**
   * The address the user most likely means by the first letters they typed ("you" →
   * "youtube.com"): the site they use most whose name starts that way, if they have used it
   * more than once or bookmarked it. `historyToo` false: bookmarks only (private tabs).
   */
  completeSite: (typed: string, historyToo: boolean) => string | null;
};

const LibraryContext = createContext<LibraryValue | null>(null);
const LibraryActionsContext = createContext<LibraryActions | null>(null);

/** What suggestions match against, worked out once per entry instead of on every keystroke. */
type IndexEntry = {
  url: string;
  title: string;
  kind: 'bookmark' | 'history';
  host: string;
  site: string;
  root: string;
  isRoot: boolean;
  lowerUrl: string;
  lowerTitle: string;
  words: string[];
  display: string;
  /** Times opened (history) and when last; a bookmark counts as none, added at `last`. */
  visits: number;
  last: number;
};

/** Runs `make` the first time the result is needed, then keeps it. */
function once<T>(make: () => T): () => T {
  let made: { value: T } | null = null;
  return () => {
    if (!made) made = { value: make() };
    return made.value;
  };
}

function indexEntry(url: string, title: string, kind: 'bookmark' | 'history', visits: number, last: number): IndexEntry {
  const host = hostOf(url).replace(/^www\./, '');
  const root = /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? url;
  const lowerTitle = title.toLowerCase();
  return {
    url,
    title,
    kind,
    host,
    site: host.replace(/^(m|mobile)\./, ''),
    root,
    isRoot: url.replace(/\/$/, '') === root,
    lowerUrl: url.toLowerCase(),
    lowerTitle,
    words: lowerTitle.split(/\s+/),
    display: displayUrl(url).toLowerCase(),
    visits,
    last,
  };
}

/**
 * How much a page or site is "the user's": visits count most, a bookmark and a recent visit
 * add to it (as in the desktop app).
 */
function weight(use: { visits: number; last: number; bookmarked: boolean }): number {
  const days = (Date.now() - use.last) / (24 * 60 * 60 * 1000);
  return use.visits + (use.bookmarked ? 4 : 0) + (days < 1 ? 3 : days < 7 ? 2 : days < 30 ? 1 : 0);
}

function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (update: (prev: T) => T) => void, () => void] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cleared before the saved value finished loading (clear data at launch): it stays cleared.
  const cleared = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (raw && !cleared.current) setValue(JSON.parse(raw) as T);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
    }, 500);
  }, [key, value, loaded]);

  const update = useCallback((fn: (prev: T) => T) => setValue(fn), []);
  const reset = useCallback(() => {
    cleared.current = true;
    setValue(initial);
    // Only the first value counts as the initial one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [value, update, reset];
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [bookmarks, setBookmarks] = usePersistentState<Bookmark[]>(KEYS.bookmarks, []);
  const [history, setHistory, resetHistory] = usePersistentState<HistoryEntry[]>(KEYS.history, []);
  const [downloads, setDownloads] = usePersistentState<DownloadRecord[]>(KEYS.downloads, []);

  const actions = useMemo<LibraryActions>(
    () => ({
      toggleBookmark: (url, title, vault) =>
        setBookmarks((list) =>
          list.some((b) => b.url === url)
            ? list.filter((b) => b.url !== url)
            : [{ id: newId(), url, title: title || url, createdAt: Date.now(), ...(vault ? { vault: true } : {}) }, ...list],
        ),
      removeBookmark: (id) => setBookmarks((list) => list.filter((b) => b.id !== id)),
      addVisit: (url, title) => {
        if (isBlank(url) || url.startsWith('data:')) return;
        setHistory((list) => {
          // One row per page: a revisit moves it to the top and counts.
          const before = list.find((h) => h.url === url);
          const rest = before ? list.filter((h) => h.url !== url) : list;
          const visits = (before?.visits ?? (before ? 1 : 0)) + 1;
          return [{ url, title: title || url, visitedAt: Date.now(), visits }, ...rest].slice(0, MAX_HISTORY);
        });
      },
      updateVisitTitle: (url, title) => {
        if (!title) return;
        setHistory((list) =>
          list[0]?.url === url && list[0].title !== title ? [{ ...list[0], title }, ...list.slice(1)] : list,
        );
      },
      removeHistory: (url) => setHistory((list) => list.filter((h) => h.url !== url)),
      clearHistory: resetHistory,
      addDownload: (record) =>
        setDownloads((list) => [{ ...record, id: newId(), startedAt: Date.now() }, ...list].slice(0, 200)),
      removeDownload: (id) => setDownloads((list) => list.filter((d) => d.id !== id)),
    }),
    [setBookmarks, setHistory, resetHistory, setDownloads],
  );

  const value = useMemo<LibraryValue>(() => {
    const bookmarkedUrls = new Set(bookmarks.map((b) => b.url));
    const normalBookmarks = bookmarks.filter((b) => !b.vault);
    // Built on the first suggestion request after a change (not on every visit).
    const index = once(() => [
      // The vault never shows up in suggestions.
      ...normalBookmarks.map((b) => indexEntry(b.url, b.title, 'bookmark', 0, b.createdAt)),
      ...history.map((h) => indexEntry(h.url, h.title, 'history', h.visits ?? 1, h.visitedAt)),
    ]);
    return {
      ...actions,
      bookmarks: normalBookmarks,
      vaultBookmarks: bookmarks.filter((b) => b.vault),
      history,
      downloads: downloads.filter((d) => !d.vault),
      vaultDownloads: downloads.filter((d) => d.vault),
      isBookmarked: (url) => bookmarkedUrls.has(url),
      suggest: (query, limit = 6) => {
        const q = query.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
        if (!q) return [];
        type Use = { visits: number; last: number; bookmarked: boolean };
        type Match = { url: string; title: string; kind: 'bookmark' | 'history'; rank: number; use: Use };
        const add = (use: Use, entry: IndexEntry) => {
          use.visits += entry.visits;
          use.last = Math.max(use.last, entry.last);
          use.bookmarked ||= entry.kind === 'bookmark';
        };
        // Typing the start of a site's name offers the site itself (its home page) first,
        // once per site (www. and mobile m. versions count as one), like Safari's top hit.
        const sites = new Map<string, Match>();
        const pages = new Map<string, Match>();
        for (const entry of index()) {
          const { url, title, kind, host, site, root, isRoot, lowerUrl, lowerTitle, words, display } = entry;
          if (host.startsWith(q) || site.startsWith(q)) {
            let known = sites.get(site);
            if (!known) {
              known = { url: `${root}/`, title: isRoot ? title : host, kind, rank: 0, use: { visits: 0, last: 0, bookmarked: false } };
              sites.set(site, known);
            } else if (isRoot && known.title === host) {
              // The site's own home page, seen further down, names it best.
              known.title = title;
            }
            if (kind === 'bookmark') known.kind = 'bookmark';
            add(known.use, entry);
            // The home page is the top hit; other pages of the site are listed as matches too.
            if (isRoot) continue;
          }
          const rank = display.startsWith(q) || words.some((w) => w.startsWith(q)) ? 1 : lowerUrl.includes(q) || lowerTitle.includes(q) ? 2 : -1;
          if (rank < 0) continue;
          const page = pages.get(url) ?? { url, title, kind, rank, use: { visits: 0, last: 0, bookmarked: false } };
          if (kind === 'bookmark') page.kind = 'bookmark';
          add(page.use, entry);
          pages.set(url, page);
        }
        // Sites first, then pages: the ones used most (and lately, and bookmarked) first.
        const seen = new Set<string>();
        return [...sites.values(), ...pages.values()]
          .sort((a, b) => a.rank - b.rank || weight(b.use) - weight(a.use))
          .filter((m) => !seen.has(m.url) && seen.add(m.url))
          .slice(0, limit)
          .map(({ url, title, kind }) => ({ url, title, kind }));
      },
      completeSite: (typed, historyToo) => {
        const start = typed.trim().toLowerCase();
        if (!start || /[\s/?#@:]/.test(typed)) return null;
        const hosts = new Map<string, { visits: number; last: number; bookmarked: boolean }>();
        for (const entry of index()) {
          if (!historyToo && entry.kind === 'history') continue;
          if (!/^https?:/i.test(entry.url) || !entry.site) continue;
          // By site: the mobile pages (m.) count for the site itself.
          const use = hosts.get(entry.site) ?? { visits: 0, last: 0, bookmarked: false };
          use.visits += entry.visits;
          use.last = Math.max(use.last, entry.last);
          use.bookmarked ||= entry.kind === 'bookmark';
          hosts.set(entry.site, use);
        }
        let best: { text: string; score: number } | null = null;
        for (const [host, use] of hosts) {
          if (use.visits < 2 && !use.bookmarked) continue;
          // Typed with or without "www.", as the user prefers.
          const text = host.startsWith(start) ? host : start.length > 3 && `www.${host}`.startsWith(start) ? `www.${host}` : '';
          if (!text || text === start) continue;
          const score = weight(use);
          if (!best || score > best.score) best = { text, score };
        }
        return best ? typed + best.text.slice(typed.length) : null;
      },
    };
  }, [bookmarks, history, downloads, actions]);

  return (
    <LibraryActionsContext.Provider value={actions}>
      <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
    </LibraryActionsContext.Provider>
  );
}

/** Library changes only: unlike useLibrary, history updates don't re-render the caller. */
export function useLibraryActions(): LibraryActions {
  const ctx = useContext(LibraryActionsContext);
  if (!ctx) throw new Error('useLibraryActions must be used inside LibraryProvider');
  return ctx;
}

export function useLibrary(): LibraryValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside LibraryProvider');
  return ctx;
}
