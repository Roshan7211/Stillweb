import { useEffect, useState } from 'react';

import { parseSuggestions, suggestionUrl, type RemoteSuggestion } from './suggestEndpoints';
import type { SearchEngineId } from './url';

export { hasRemoteSuggestions, type RemoteSuggestion } from './suggestEndpoints';

const CACHE_LIMIT = 60;
const cache = new Map<string, RemoteSuggestion[]>();

function remember(key: string, items: RemoteSuggestion[]) {
  cache.set(key, items);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

/**
 * Search engine suggestions for what is being typed. Requests are debounced, cancelled when
 * the text changes and cached; until fresh results arrive the previous ones stay, so the
 * list doesn't flicker while typing.
 */
export function useSearchSuggestions(query: string, engine: SearchEngineId, enabled: boolean): RemoteSuggestion[] {
  const [latest, setLatest] = useState<RemoteSuggestion[]>([]);
  const q = query.trim();
  const url = enabled && q ? suggestionUrl(engine, q) : null;
  const key = url ? `${engine}:${q.toLowerCase()}` : '';

  useEffect(() => {
    if (!key || !url || cache.has(key)) return;
    const controller = new AbortController();
    const debounce = setTimeout(() => {
      const timeout = setTimeout(() => controller.abort(), 3000);
      // No cookies either way: the engine can't tie what's typed to a person or a session.
      fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          const items = parseSuggestions(json);
          remember(key, items);
          setLatest(items);
        })
        .catch(() => {})
        .finally(() => clearTimeout(timeout));
    }, 120);
    return () => {
      clearTimeout(debounce);
      controller.abort();
    };
  }, [key, url]);

  if (!key) return [];
  return cache.get(key) ?? latest;
}
