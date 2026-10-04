import { useEffect, useState } from 'react';

import type { SearchEngineId } from './url';

/**
 * Suggestion endpoints, all answering OpenSearch JSON: `[query, [phrases], [descriptions], ...]`.
 * Engines without a public endpoint (and custom ones) get no remote suggestions.
 */
const ENDPOINTS: Partial<Record<SearchEngineId, string>> = {
  // client=chrome also marks site results ("NAVIGATION") so they can be offered as sites.
  google: 'https://suggestqueries.google.com/complete/search?client=chrome&ie=UTF-8&oe=UTF-8&q=%s',
  duckduckgo: 'https://duckduckgo.com/ac/?type=list&q=%s',
  bing: 'https://api.bing.com/osjson.aspx?query=%s',
  ecosia: 'https://ac.ecosia.org/autocomplete?type=list&q=%s',
  startpage: 'https://www.startpage.com/osuggestions?q=%s',
};

export type RemoteSuggestion = { kind: 'search'; text: string } | { kind: 'site'; url: string; title: string };

export function hasRemoteSuggestions(engine: SearchEngineId): boolean {
  return engine in ENDPOINTS;
}

function parse(json: unknown): RemoteSuggestion[] {
  if (!Array.isArray(json) || !Array.isArray(json[1])) return [];
  const phrases = json[1] as unknown[];
  const descriptions = Array.isArray(json[2]) ? (json[2] as unknown[]) : [];
  const meta = json[4] as { 'google:suggesttype'?: unknown[] } | undefined;
  const types = Array.isArray(meta?.['google:suggesttype']) ? meta['google:suggesttype'] : [];
  const out: RemoteSuggestion[] = [];
  phrases.forEach((phrase, i) => {
    if (typeof phrase !== 'string' || !phrase) return;
    if (types[i] === 'NAVIGATION' && /^https?:\/\//i.test(phrase)) {
      const title = typeof descriptions[i] === 'string' ? (descriptions[i] as string) : '';
      out.push({ kind: 'site', url: phrase, title });
    } else {
      out.push({ kind: 'search', text: phrase });
    }
  });
  return out;
}

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
  const template = enabled ? ENDPOINTS[engine] : undefined;
  const q = query.trim();
  const key = template && q ? `${engine}:${q.toLowerCase()}` : '';

  useEffect(() => {
    if (!key || !template || cache.has(key)) return;
    const controller = new AbortController();
    const debounce = setTimeout(() => {
      const timeout = setTimeout(() => controller.abort(), 3000);
      fetch(template.replace('%s', encodeURIComponent(q)), { signal: controller.signal, headers: { Accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          const items = parse(json);
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
  }, [key, template, q]);

  if (!key) return [];
  return cache.get(key) ?? latest;
}
