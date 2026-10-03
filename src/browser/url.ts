export type SearchEngineId = 'duckduckgo' | 'brave' | 'startpage' | 'ecosia' | 'bing' | 'google' | 'custom';

export const SEARCH_ENGINES: { id: SearchEngineId; label: string; template: string }[] = [
  { id: 'google', label: 'Google', template: 'https://www.google.com/search?q=%s' },
  { id: 'duckduckgo', label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'brave', label: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  { id: 'startpage', label: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  { id: 'ecosia', label: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
  { id: 'bing', label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
];

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'google';

export function searchUrl(query: string, engine: SearchEngineId, customTemplate?: string): string {
  const template =
    engine === 'custom' && customTemplate?.includes('%s')
      ? customTemplate
      : (SEARCH_ENGINES.find((e) => e.id === engine) ?? SEARCH_ENGINES[0]).template;
  return template.replace('%s', encodeURIComponent(query.trim()));
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_LIKE = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62})(:\d{1,5})?([/?#].*)?$/i;

/** Turns address bar input into a URL: a full URL, a bare host, or a search. */
export function resolveInput(input: string, engine: SearchEngineId, customTemplate?: string): string {
  const text = input.trim();
  if (!text) return '';
  if (/\s/.test(text)) return searchUrl(text, engine, customTemplate);
  if (/^(https?|about|data|file):/i.test(text)) return text;
  if (SCHEME.test(text) && !/^[^:]+:\d/.test(text)) {
    // Something like "mailto:x" — still a URL, but "example.com:8080" isn't a scheme.
    return text;
  }
  if (HOST_LIKE.test(text)) {
    const isLocal = /^(localhost|(\d{1,3}\.){3}\d{1,3})/i.test(text);
    return `${isLocal ? 'http' : 'https'}://${text}`;
  }
  return searchUrl(text, engine, customTemplate);
}

export function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return match ? match[1].toLowerCase() : '';
}

/** Address bar display: host plus path, without scheme or "www.". */
export function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

/** Unfocused address bar: just the site, which is easier to read and harder to spoof. */
export function displayHost(url: string): string {
  if (!url || url === 'about:blank') return '';
  const host = hostOf(url).replace(/^www\./, '');
  return host || displayUrl(url);
}

/** Registrable-ish site key for per-site settings ("news.example.co.uk" -> host as-is minus www). */
export function siteKey(url: string): string {
  return hostOf(url).replace(/^www\./, '');
}

export function isBlank(url: string | undefined): boolean {
  return !url || url === 'about:blank';
}
