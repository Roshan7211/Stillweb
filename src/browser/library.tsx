import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { isBlank } from './url';

export type Bookmark = { id: string; url: string; title: string; createdAt: number };
export type HistoryEntry = { url: string; title: string; visitedAt: number };
export type DownloadRecord = {
  id: string;
  /** Android DownloadManager id; absent when the platform handled it (iOS). */
  nativeId?: number;
  url: string;
  fileName: string;
  filePath?: string;
  startedAt: number;
};

const KEYS = { bookmarks: 'library.bookmarks', history: 'library.history', downloads: 'library.downloads' };
const MAX_HISTORY = 2000;

type LibraryValue = {
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadRecord[];
  isBookmarked: (url: string) => boolean;
  toggleBookmark: (url: string, title: string) => void;
  removeBookmark: (id: string) => void;
  addVisit: (url: string, title: string) => void;
  updateVisitTitle: (url: string, title: string) => void;
  removeHistory: (url: string) => void;
  clearHistory: () => void;
  addDownload: (record: Omit<DownloadRecord, 'id' | 'startedAt'>) => void;
  removeDownload: (id: string) => void;
  /** Bookmarks first, then recent history, matching the typed text. */
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
    return {
      bookmarks,
      history,
      downloads,
      isBookmarked: (url) => bookmarkedUrls.has(url),
      toggleBookmark: (url, title) =>
        setBookmarks((list) =>
          list.some((b) => b.url === url)
            ? list.filter((b) => b.url !== url)
            : [{ id: newId(), url, title: title || url, createdAt: Date.now() }, ...list],
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
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const seen = new Set<string>();
        const out: { url: string; title: string; kind: 'bookmark' | 'history' }[] = [];
        const consider = (url: string, title: string, kind: 'bookmark' | 'history') => {
          if (out.length >= limit || seen.has(url)) return;
          if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
            seen.add(url);
            out.push({ url, title, kind });
          }
        };
        bookmarks.forEach((b) => consider(b.url, b.title, 'bookmark'));
        history.forEach((h) => consider(h.url, h.title, 'history'));
        return out;
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
