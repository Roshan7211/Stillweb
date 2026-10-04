import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { displayUrl, hostOf, isBlank } from './url';

/** `vault`: saved from a private tab into the Face ID-locked vault (Stillweb Plus). */
export type Bookmark = { id: string; url: string; title: string; createdAt: number; vault?: boolean };
export type HistoryEntry = { url: string; title: string; visitedAt: number };
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

type LibraryValue = {
  /** Normal bookmarks; the vault's are only in `vaultBookmarks`. */
  bookmarks: Bookmark[];
  vaultBookmarks: Bookmark[];
  history: HistoryEntry[];
  /** Normal downloads; the vault's are only in `vaultDownloads`. */
  downloads: DownloadRecord[];
  vaultDownloads: DownloadRecord[];
  /** Bookmarked anywhere (normal or vault). */
  isBookmarked: (url: string) => boolean;
  /** Adds (to the vault when `vault`) or removes the bookmark for this page. */
  toggleBookmark: (url: string, title: string, vault?: boolean) => void;
  removeBookmark: (id: string) => void;
  addVisit: (url: string, title: string) => void;
  updateVisitTitle: (url: string, title: string) => void;
  removeHistory: (url: string) => void;
  clearHistory: () => void;
  addDownload: (record: Omit<DownloadRecord, 'id' | 'startedAt'>) => void;
  removeDownload: (id: string) => void;
  /** Sites whose name starts with the text first, then other bookmark and history matches. */
  suggest: (query: string, limit?: number) => { url: string; title: string; kind: 'bookmark' | 'history' }[];
};

const LibraryContext = createContext<LibraryValue | null>(null);

function usePersistentState<T>(key: string, initial: T): [T, (update: (prev: T) => T) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (raw) setValue(JSON.parse(raw) as T);
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
  return [value, update, loaded];
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [bookmarks, setBookmarks] = usePersistentState<Bookmark[]>(KEYS.bookmarks, []);
  const [history, setHistory] = usePersistentState<HistoryEntry[]>(KEYS.history, []);
  const [downloads, setDownloads] = usePersistentState<DownloadRecord[]>(KEYS.downloads, []);

  const value = useMemo<LibraryValue>(() => {
    const bookmarkedUrls = new Set(bookmarks.map((b) => b.url));
    const normalBookmarks = bookmarks.filter((b) => !b.vault);
    return {
      bookmarks: normalBookmarks,
      vaultBookmarks: bookmarks.filter((b) => b.vault),
      history,
      downloads: downloads.filter((d) => !d.vault),
      vaultDownloads: downloads.filter((d) => d.vault),
      isBookmarked: (url) => bookmarkedUrls.has(url),
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
          // One row per page: a revisit moves it to the top.
          const rest = list.filter((h) => h.url !== url);
          return [{ url, title: title || url, visitedAt: Date.now() }, ...rest].slice(0, MAX_HISTORY);
        });
      },
      updateVisitTitle: (url, title) => {
        if (!title) return;
        setHistory((list) =>
          list[0]?.url === url && list[0].title !== title ? [{ ...list[0], title }, ...list.slice(1)] : list,
        );
      },
      removeHistory: (url) => setHistory((list) => list.filter((h) => h.url !== url)),
      clearHistory: () => setHistory(() => []),
      addDownload: (record) =>
        setDownloads((list) => [{ ...record, id: newId(), startedAt: Date.now() }, ...list].slice(0, 200)),
      removeDownload: (id) => setDownloads((list) => list.filter((d) => d.id !== id)),
      suggest: (query, limit = 6) => {
        const q = query.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
        if (!q) return [];
        type Match = { url: string; title: string; kind: 'bookmark' | 'history'; rank: number };
        const matches: Match[] = [];
        // Typing the start of a site's name offers the site itself (its home page) first,
        // once per site (www. and mobile m. versions count as one), like Safari's top hit.
        const sites = new Map<string, Match>();
        const consider = (url: string, title: string, kind: 'bookmark' | 'history') => {
          const host = hostOf(url).replace(/^www\./, '');
          const site = host.replace(/^(m|mobile)\./, '');
          const lowerTitle = title.toLowerCase();
          if (host.startsWith(q) || site.startsWith(q)) {
            const root = /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? url;
            const isRoot = url.replace(/\/$/, '') === root;
            const known = sites.get(site);
            if (!known) {
              const match: Match = { url: `${root}/`, title: isRoot ? title : host, kind, rank: kind === 'bookmark' ? 0 : 1 };
              sites.set(site, match);
              matches.push(match);
            } else if (isRoot && known.title === host) {
              // The site's own home page, seen further down, names it best.
              known.title = title;
            }
            // The home page is the top hit; other pages of the site are listed as matches too.
            if (isRoot) return;
          }
          if (displayUrl(url).toLowerCase().startsWith(q) || lowerTitle.split(/\s+/).some((w) => w.startsWith(q))) {
            matches.push({ url, title, kind, rank: 2 });
          } else if (url.toLowerCase().includes(q) || lowerTitle.includes(q)) {
            matches.push({ url, title, kind, rank: 3 });
          }
        };
        // The vault never shows up in suggestions.
        normalBookmarks.forEach((b) => consider(b.url, b.title, 'bookmark'));
        history.forEach((h) => consider(h.url, h.title, 'history'));
        const seen = new Set<string>();
        return matches
          .sort((a, b) => a.rank - b.rank) // stable: bookmarks, then most recent history
          .filter((m) => !seen.has(m.url) && seen.add(m.url))
          .slice(0, limit)
          .map(({ url, title, kind }) => ({ url, title, kind }));
      },
    };
  }, [bookmarks, history, downloads, setBookmarks, setHistory, setDownloads]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside LibraryProvider');
  return ctx;
}
