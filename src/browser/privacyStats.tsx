import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** One day of blocking: the total, and counts by site visited and by blocked domain. */
export type DayStats = { blocked: number; sites: Record<string, number>; domains: Record<string, number> };

/** Days by local date ("2026-10-04"). */
type StatsByDay = Record<string, DayStats>;

const STORAGE_KEY = 'privacy.stats.v1';
const KEEP_DAYS = 400;
/** Per day, only the busiest sites and domains are kept, so storage stays small. */
const MAX_ENTRIES = 200;

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const sum = { ...a };
  for (const [key, n] of Object.entries(b)) sum[key] = (sum[key] ?? 0) + n;
  return sum;
}

/** Saved days plus what was recorded while they loaded, added up day by day. */
export function mergeDays(saved: StatsByDay, recent: StatsByDay): StatsByDay {
  const merged: StatsByDay = { ...saved };
  for (const [key, day] of Object.entries(recent)) {
    const old = merged[key];
    merged[key] = old
      ? {
          blocked: old.blocked + day.blocked,
          sites: trim(addCounts(old.sites, day.sites)),
          domains: trim(addCounts(old.domains, day.domains)),
        }
      : day;
  }
  return merged;
}

function trim(map: Record<string, number>): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ENTRIES) return map;
  return Object.fromEntries(
    keys
      .sort((a, b) => map[b] - map[a])
      .slice(0, MAX_ENTRIES)
      .map((k) => [k, map[k]]),
  );
}

type StatsActions = {
  /**
   * Adds blocked requests. Private tabs pass no site or domains: only the count is kept, so
   * the report never shows where private browsing went.
   */
  record: (count: number, site?: string | null, domains?: Record<string, number>) => void;
  /** Forgets everything (with the rest of the browsing data). */
  clear: () => void;
};

const ActionsContext = createContext<StatsActions | null>(null);
const DataContext = createContext<StatsByDay | null>(null);

export function PrivacyStatsProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<StatsByDay>({});
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cleared before the saved days finished loading (clear data at launch): they stay gone.
  const cleared = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw && !cleared.current) setDays((recent) => mergeDays(JSON.parse(raw) as StatsByDay, recent));
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
  }, []);

  // Saved a few seconds after the last change: blocking events arrive in bursts.
  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(days)).catch(() => {});
    }, 3000);
  }, [days]);

  const record = useCallback<StatsActions['record']>((count, site, domains) => {
    // Counter resets (a new page) report nothing new.
    if (count <= 0 && !(domains && Object.keys(domains).length)) return;
    const key = dayKey(new Date());
    setDays((prev) => {
      const day = prev[key] ?? { blocked: 0, sites: {}, domains: {} };
      const sites = site && count > 0 ? trim({ ...day.sites, [site]: (day.sites[site] ?? 0) + count }) : day.sites;
      const dayDomains = domains && Object.keys(domains).length ? trim(addCounts(day.domains, domains)) : day.domains;
      const next: StatsByDay = { ...prev, [key]: { blocked: day.blocked + Math.max(count, 0), sites, domains: dayDomains } };
      // Drop days past the history kept.
      const oldest = dayKey(new Date(Date.now() - KEEP_DAYS * 86400000));
      for (const k of Object.keys(next)) if (k < oldest) delete next[k];
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    cleared.current = true;
    setDays({});
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const actions = useMemo(() => ({ record, clear }), [record, clear]);
  return (
    <ActionsContext.Provider value={actions}>
      <DataContext.Provider value={days}>{children}</DataContext.Provider>
    </ActionsContext.Provider>
  );
}

/** Recording and clearing; stable, so recording doesn't re-render the browser. */
export function usePrivacyStatsActions(): StatsActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('usePrivacyStatsActions must be used inside PrivacyStatsProvider');
  return ctx;
}

export function usePrivacyStats(): StatsByDay {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('usePrivacyStats must be used inside PrivacyStatsProvider');
  return ctx;
}

/** Totals over the last `count` days (including today), oldest first. */
export function lastDays(days: StatsByDay, count: number): { key: string; date: Date; blocked: number }[] {
  const out = [];
  const today = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = dayKey(date);
    out.push({ key, date, blocked: days[key]?.blocked ?? 0 });
  }
  return out;
}

/** Biggest entries of `field` summed over the given days. */
export function topEntries(days: StatsByDay, keys: string[], field: 'sites' | 'domains', limit: number): [string, number][] {
  const sum: Record<string, number> = {};
  for (const key of keys) {
    const map = days[key]?.[field];
    if (!map) continue;
    for (const [name, n] of Object.entries(map)) sum[name] = (sum[name] ?? 0) + n;
  }
  return Object.entries(sum)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}
