// Search suggestions without React, shared by the mobile hook (suggest.ts) and the desktop app.
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

/** Reads an OpenSearch suggestions answer; anything unexpected gives an empty list. */
export function parseSuggestions(json: unknown): RemoteSuggestion[] {
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

/** The address to ask for suggestions for `query`, or null when the engine has no endpoint. */
export function suggestionUrl(engine: SearchEngineId, query: string): string | null {
  const template = ENDPOINTS[engine];
  return template ? template.replace('%s', encodeURIComponent(query.trim())) : null;
}
