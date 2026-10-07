import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';

export type Tab = {
  id: string;
  /** Last committed URL ('' for a new tab page). */
  url: string;
  title: string;
  incognito: boolean;
  /** Stillweb Plus profile (its own cookies and site data); unset = the default profile. */
  profileId?: string;
  openerId?: string;
  lastActive: number;
  // Live page state, not persisted.
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  progress: number;
  blocked: number;
  shieldsActive: boolean;
  secure: boolean;
  reader: boolean;
  /** Bumped to make the web view load `url` again (e.g. from the address bar). */
  navigationKey: number;
  /** file:// URI of the latest page snapshot for the tab switcher (cache only, never persisted). */
  thumbnail?: string;
  /** Width / height of the page area when the thumbnail was taken. */
  thumbAspect?: number;
  /** iOS: the window a page opened, waiting in native code to be shown by this tab's view. */
  popupId?: string;
  /** Listen Mode: playback speed for media in this tab (1 when unset). */
  playbackRate?: number;
  /** Listen Mode's "end of this one" sleep timer: armed on this site (host without www.). */
  stopAtEnd?: string;
  /** The page's own background is dark (iOS: the status bar over it stays readable). */
  pageDark?: boolean;
  /**
   * The tab has had its page open before: a web view created for it now (after a restart, or
   * after its view was released) loads the page again without playing its media.
   */
  visited?: boolean;
  /** iOS: media with sound is playing in the tab (its web view is never released meanwhile). */
  playing?: boolean;
};

type State = { tabs: Tab[]; activeId: string | null; restored: boolean };

type Action =
  | { type: 'restore'; tabs: Tab[]; activeId: string | null }
  | { type: 'open'; tab: Tab; activate: boolean }
  | { type: 'close'; id: string }
  | { type: 'closeAll'; incognito: boolean }
  | { type: 'closeMany'; ids: string[] }
  | { type: 'activate'; id: string }
  | { type: 'update'; id: string; patch: Partial<Tab> };

const STORAGE_KEY = 'tabs.v1';
/**
 * How many recently used tabs keep a live web view; others reload when revisited. A tab that
 * is playing media stays live beyond that, so music doesn't stop because more tabs were opened.
 */
export const LIVE_TAB_LIMIT = 3;

/** Snapshot files live in the cache and never outlive the session (private tabs included). */
function deleteThumbnail(uri?: string) {
  if (!uri) return;
  try {
    const file = new File(uri.split('?')[0]);
    if (file.exists) file.delete();
  } catch {}
}

function deleteAllThumbnails() {
  try {
    const dir = new Directory(Paths.cache, 'thumbs');
    if (dir.exists) dir.delete();
  } catch {}
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function makeTab(url: string, incognito: boolean, openerId?: string, popupId?: string, profileId?: string): Tab {
  return {
    id: newId(),
    url,
    title: '',
    incognito,
    profileId: incognito ? undefined : profileId,
    openerId,
    popupId,
    lastActive: Date.now(),
    canGoBack: false,
    canGoForward: false,
    loading: false,
    progress: 0,
    blocked: 0,
    shieldsActive: true,
    secure: false,
    reader: false,
    navigationKey: 0,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'restore':
      return { tabs: action.tabs, activeId: action.activeId, restored: true };
    case 'open': {
      const tab = action.tab;
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeId: action.activate || !state.activeId ? tab.id : state.activeId,
      };
    }
    case 'close': {
      const closing = state.tabs.find((t) => t.id === action.id);
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      let activeId = state.activeId;
      if (state.activeId === action.id) {
        // Prefer the opener, then the most recent tab in the same mode, then any tab.
        const sameMode = tabs.filter((t) => t.incognito === closing?.incognito);
        const opener = closing?.openerId ? tabs.find((t) => t.id === closing.openerId) : undefined;
        const recent = [...(sameMode.length ? sameMode : tabs)].sort((a, b) => b.lastActive - a.lastActive)[0];
        activeId = (opener ?? recent)?.id ?? null;
      }
      return { ...state, tabs, activeId };
    }
    case 'closeAll': {
      const tabs = state.tabs.filter((t) => t.incognito !== action.incognito);
      const active = tabs.find((t) => t.id === state.activeId);
      return { ...state, tabs, activeId: active ? active.id : (tabs[tabs.length - 1]?.id ?? null) };
    }
    case 'closeMany': {
      const tabs = state.tabs.filter((t) => !action.ids.includes(t.id));
      const active = tabs.find((t) => t.id === state.activeId);
      const recent = [...tabs].sort((a, b) => b.lastActive - a.lastActive)[0];
      return { ...state, tabs, activeId: active ? active.id : (recent?.id ?? null) };
    }
    case 'activate':
      return {
        ...state,
        activeId: action.id,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, lastActive: Date.now() } : t)),
      };
    case 'update': {
      // Pages report the same state many times (progress, title, history); unchanged
      // patches keep the old state so nothing re-renders.
      const index = state.tabs.findIndex((t) => t.id === action.id);
      const tab = state.tabs[index];
      if (!tab) return state;
      const patch = action.patch as Record<string, unknown>;
      if (Object.keys(patch).every((k) => Object.is(patch[k], (tab as Record<string, unknown>)[k]))) return state;
      const tabs = state.tabs.slice();
      tabs[index] = { ...tab, ...action.patch };
      return { ...state, tabs };
    }
  }
}

/** Tab actions; their identities never change, so using them doesn't re-render on tab updates. */
type TabActions = {
  /**
   * Opens a tab. Normal tabs open in `profileId` when given (null = the default profile),
   * otherwise in the opener's profile, else the current tab's.
   */
  openTab: (
    url: string,
    options?: { incognito?: boolean; openerId?: string; activate?: boolean; popupId?: string; profileId?: string | null },
  ) => string;
  closeTab: (id: string) => void;
  closeAll: (incognito: boolean) => void;
  /** Closes these tabs (a profile's tabs, for example). */
  closeTabs: (ids: string[]) => void;
  activate: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  /** Loads a URL in a tab from the app (address bar, bookmarks, ...). */
  navigate: (id: string, url: string) => void;
};

type TabsValue = TabActions & {
  tabs: Tab[];
  activeTab: Tab | null;
  restored: boolean;
  /** Ids of tabs whose web views stay mounted. */
  liveIds: Set<string>;
};

const TabsContext = createContext<TabsValue | null>(null);
const TabActionsContext = createContext<TabActions | null>(null);

export function TabsProvider({ children, clearOnStart }: { children: ReactNode; clearOnStart: boolean }) {
  const [state, dispatch] = useReducer(reducer, { tabs: [], activeId: null, restored: false });
  const live = useRef<string[]>([]);

  useEffect(() => {
    deleteAllThumbnails();
    (async () => {
      let tabs: Tab[] = [];
      let activeId: string | null = null;
      if (!clearOnStart) {
        try {
          const raw = await AsyncStorage.getItem(STORAGE_KEY);
          if (raw) {
            const saved = JSON.parse(raw) as {
              tabs: { id: string; url: string; title: string; profileId?: string }[];
              activeId: string | null;
            };
            tabs = saved.tabs.map((t) => ({
              ...makeTab(t.url, false, undefined, undefined, t.profileId),
              id: t.id,
              title: t.title,
              // A new tab page has nothing to load again: its first page is one the user asks for.
              visited: !!t.url,
            }));
            activeId = tabs.some((t) => t.id === saved.activeId) ? saved.activeId : (tabs[0]?.id ?? null);
          }
        } catch {}
      }
      if (!tabs.length) {
        const tab = makeTab('', false);
        tabs = [tab];
        activeId = tab.id;
      }
      dispatch({ type: 'restore', tabs, activeId });
    })();
    // Only on launch: clearOnStart is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist normal tabs only; private tabs never touch storage.
  const persisted = useMemo(
    () =>
      JSON.stringify({
        tabs: state.tabs.filter((t) => !t.incognito).map(({ id, url, title, profileId }) => ({ id, url, title, profileId })),
        activeId: state.tabs.find((t) => t.id === state.activeId && !t.incognito)?.id ?? null,
      }),
    [state.tabs, state.activeId],
  );
  useEffect(() => {
    if (state.restored) AsyncStorage.setItem(STORAGE_KEY, persisted).catch(() => {});
  }, [persisted, state.restored]);

  const liveIds = useMemo(() => {
    const ids = state.tabs.map((t) => t.id);
    let next = live.current.filter((id) => ids.includes(id));
    if (state.activeId) next = [state.activeId, ...next.filter((id) => id !== state.activeId)];
    const playing = new Set(state.tabs.filter((t) => t.playing).map((t) => t.id));
    live.current = next.filter((id, index) => index < LIVE_TAB_LIMIT || playing.has(id));
    return new Set(live.current);
  }, [state.tabs, state.activeId]);

  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  const activeIdRef = useRef(state.activeId);
  activeIdRef.current = state.activeId;

  const openTab = useCallback<TabsValue['openTab']>((url, options = {}) => {
    let profileId = options.profileId;
    if (profileId === undefined) {
      // Links stay in their profile; otherwise the profile of the tab in use (or used last).
      const all = tabsRef.current;
      const opener = options.openerId ? all.find((t) => t.id === options.openerId) : undefined;
      const current = all.find((t) => t.id === activeIdRef.current);
      const source =
        (opener && !opener.incognito ? opener : undefined) ??
        (current && !current.incognito ? current : undefined) ??
        all.filter((t) => !t.incognito).sort((a, b) => b.lastActive - a.lastActive)[0];
      profileId = source?.profileId;
    }
    const tab = makeTab(url, options.incognito ?? false, options.openerId, options.popupId, profileId ?? undefined);
    dispatch({ type: 'open', tab, activate: options.activate ?? true });
    return tab.id;
  }, []);

  const closeTab = useCallback((id: string) => {
    deleteThumbnail(tabsRef.current.find((t) => t.id === id)?.thumbnail);
    dispatch({ type: 'close', id });
  }, []);
  const closeAll = useCallback((incognito: boolean) => {
    tabsRef.current.filter((t) => t.incognito === incognito).forEach((t) => deleteThumbnail(t.thumbnail));
    dispatch({ type: 'closeAll', incognito });
  }, []);
  const closeTabs = useCallback((ids: string[]) => {
    tabsRef.current.filter((t) => ids.includes(t.id)).forEach((t) => deleteThumbnail(t.thumbnail));
    dispatch({ type: 'closeMany', ids });
  }, []);
  const activate = useCallback((id: string) => dispatch({ type: 'activate', id }), []);
  const updateTab = useCallback((id: string, patch: Partial<Tab>) => dispatch({ type: 'update', id, patch }), []);

  const navigate = useCallback((id: string, url: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    dispatch({ type: 'update', id, patch: { url, reader: false, navigationKey: (tab?.navigationKey ?? 0) + 1 } });
  }, []);

  const actions = useMemo<TabActions>(
    () => ({ openTab, closeTab, closeAll, closeTabs, activate, updateTab, navigate }),
    [openTab, closeTab, closeAll, closeTabs, activate, updateTab, navigate],
  );
  const value = useMemo<TabsValue>(
    () => ({
      tabs: state.tabs,
      activeTab: state.tabs.find((t) => t.id === state.activeId) ?? null,
      restored: state.restored,
      liveIds,
      ...actions,
    }),
    [state.tabs, state.activeId, state.restored, liveIds, actions],
  );

  return (
    <TabActionsContext.Provider value={actions}>
      <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
    </TabActionsContext.Provider>
  );
}

export function useTabs(): TabsValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('useTabs must be used inside TabsProvider');
  return ctx;
}

export function useTabActions(): TabActions {
  const ctx = useContext(TabActionsContext);
  if (!ctx) throw new Error('useTabActions must be used inside TabsProvider');
  return ctx;
}
