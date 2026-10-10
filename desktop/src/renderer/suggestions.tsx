// Suggestions while typing, shared by the address bar and the home page's search field.
import { Clock, Globe, Search, Star } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { displayUrl, looksLikeUrl } from '../../../src/browser/url';
import type { Suggestion } from '../shared/types';
import { api } from './api';

const LIMIT = 9;
/** How long to wait after a key before asking the search engine (history is asked at once). */
const REMOTE_DELAY_MS = 100;

/** What a suggestion puts in the field, and where choosing it goes. */
export const valueOf = (suggestion: Suggestion): string => (suggestion.kind === 'search' ? suggestion.text : suggestion.url);

/** The list for `query`: what was typed first, then history and bookmarks, then the search engine's. */
function merge(query: string, local: Suggestion[], remote: Suggestion[]): Suggestion[] {
  const typed: Suggestion = looksLikeUrl(query) ? { kind: 'site', url: query, title: '' } : { kind: 'search', text: query };
  const out: Suggestion[] = [typed];
  const seen = new Set([valueOf(typed).toLowerCase()]);
  for (const suggestion of [...local, ...remote]) {
    const key = valueOf(suggestion).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
    if (out.length >= LIMIT) break;
  }
  return out;
}

export function useSuggestions() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(-1);
  const request = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const last = useRef<{ query: string; local: Suggestion[]; remote: Suggestion[] }>({ query: '', local: [], remote: [] });

  const clear = useCallback(() => {
    request.current++;
    window.clearTimeout(timer.current);
    setItems([]);
    setSelected(-1);
  }, []);

  /** Call with the field's text after every change. */
  const ask = useCallback(
    (value: string) => {
      const query = value.trim();
      if (!query) return clear();
      const id = ++request.current;
      window.clearTimeout(timer.current);
      setSelected(-1);

      // The list never empties while typing: what the search engine said for the text so far
      // stays (where it still fits) until its answer for the new text arrives.
      const before = last.current;
      const lower = query.toLowerCase();
      const fitting = lower.startsWith(before.query.toLowerCase()) ? before.remote.filter((s) => s.kind !== 'search' || s.text.toLowerCase().startsWith(lower)) : [];
      const state = { query, local: [] as Suggestion[], remote: fitting };
      last.current = state;
      setItems(merge(query, [], fitting));

      void api.suggestLocal(query).then((local) => {
        if (id !== request.current) return;
        state.local = local;
        setItems(merge(query, state.local, state.remote));
      });
      timer.current = window.setTimeout(() => {
        void api.suggestRemote(query).then((remote) => {
          if (id !== request.current) return;
          state.remote = remote;
          setItems(merge(query, state.local, state.remote));
        });
      }, REMOTE_DELAY_MS);
    },
    [clear],
  );

  /** Arrow keys: moves the selection and returns the text to show (`typed` when nothing is selected). */
  const move = useCallback(
    (step: 1 | -1, typed: string): string => {
      // One step past either end is "nothing selected": what was typed.
      const next = ((selected + 1 + step + items.length + 1) % (items.length + 1)) - 1;
      setSelected(next);
      return next >= 0 ? valueOf(items[next]) : typed;
    },
    [items, selected],
  );

  return { items, selected, ask, clear, move };
}

function SuggestionIcon({ suggestion }: { suggestion: Suggestion }) {
  if (suggestion.kind === 'search') return <Search size={15} />;
  if (suggestion.kind === 'history') return <Clock size={15} />;
  if (suggestion.kind === 'bookmark') return <Star size={15} />;
  return <Globe size={15} />;
}

/** The part of a suggestion beyond what was typed stands out, so the eye goes to what is new. */
function Completed({ text, typed }: { text: string; typed: string }) {
  const start = typed.trim().toLowerCase();
  if (!start || !text.toLowerCase().startsWith(start) || text.length === start.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, start.length)}
      <b>{text.slice(start.length)}</b>
    </>
  );
}

type ListProps = { items: Suggestion[]; selected: number; typed: string; onPick: (value: string) => void };

export function SuggestionList({ items, selected, typed, onPick }: ListProps) {
  return (
    <ul className="suggestions" role="listbox">
      {items.map((suggestion, index) => (
        <li
          key={`${suggestion.kind}:${valueOf(suggestion)}`}
          role="option"
          aria-selected={index === selected}
          className={index === selected ? 'selected' : undefined}
          // Before the field's blur, which would close the list.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(valueOf(suggestion));
          }}>
          <span className="suggestion-icon">
            <SuggestionIcon suggestion={suggestion} />
          </span>
          <span className="suggestion-text">
            {suggestion.kind === 'search' ? <Completed text={suggestion.text} typed={typed} /> : suggestion.title || displayUrl(suggestion.url)}
          </span>
          {suggestion.kind !== 'search' && suggestion.title ? <span className="suggestion-url">{displayUrl(suggestion.url)}</span> : null}
          {index === 0 ? <span className="suggestion-hint">{suggestion.kind === 'search' ? 'Search' : 'Open'}</span> : null}
        </li>
      ))}
    </ul>
  );
}
