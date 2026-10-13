// Suggestions while typing, shared by the address bar and the home page's search field.
import { Clock, Globe, Search, Star } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';

import { displayUrl, looksLikeUrl } from '../../../src/browser/url';
import type { SiteCompletion, Suggestion } from '../shared/types';
import { api } from './api';

const LIMIT = 9;
/** How long to wait after a key before asking the search engine (history is asked at once). */
const REMOTE_DELAY_MS = 100;

/** What a suggestion puts in the field, and where choosing it goes. */
export const valueOf = (suggestion: Suggestion): string => (suggestion.kind === 'search' ? suggestion.text : suggestion.url);

/** The list for `query`: what was typed first, then history and bookmarks, then the search engine's. */
function merge(query: string, local: Suggestion[], remote: Suggestion[], completion: SiteCompletion | null): Suggestion[] {
  const typed: Suggestion = looksLikeUrl(query) ? { kind: 'site', url: query, title: '' } : { kind: 'search', text: query };
  // When the letters start a site the user goes to, that site is what Enter opens, so it is
  // the first row; searching for the letters themselves is the second.
  const out: Suggestion[] = completion ? [{ kind: 'site', url: completion.url, title: completion.text }, typed] : [typed];
  const seen = new Set(out.map((suggestion) => valueOf(suggestion).toLowerCase()));
  for (const suggestion of [...local, ...remote]) {
    const key = valueOf(suggestion).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
    if (out.length >= LIMIT) break;
  }
  return out;
}

/** A completion as the field shows it: for which typed text, and the address Enter opens. */
export type Completion = SiteCompletion & { typed: string };

/** Whether `completion` still continues what is in the field now. */
const continues = (completion: SiteCompletion, typed: string) => typed.length > 0 && completion.text.toLowerCase().startsWith(typed.toLowerCase());

export function useSuggestions() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(-1);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const request = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const last = useRef<{ query: string; remote: Suggestion[]; completion: SiteCompletion | null }>({ query: '', remote: [], completion: null });

  const clear = useCallback(() => {
    request.current++;
    window.clearTimeout(timer.current);
    setItems([]);
    setSelected(-1);
    setCompletion(null);
  }, []);

  /**
   * Call with the field's text after every change. `complete` is false when the change was a
   * deletion: someone removing letters does not want them put back.
   */
  const ask = useCallback(
    (value: string, complete = true) => {
      const query = value.trim();
      if (!query) return clear();
      const id = ++request.current;
      window.clearTimeout(timer.current);
      setSelected(-1);

      // Nothing empties while typing: what was known for the text so far stays, where it
      // still fits, until the answers for the new text arrive.
      const before = last.current;
      const lower = query.toLowerCase();
      const fitting = lower.startsWith(before.query.toLowerCase()) ? before.remote.filter((s) => s.kind !== 'search' || s.text.toLowerCase().startsWith(lower)) : [];
      const kept = complete && before.completion && continues(before.completion, value) ? before.completion : null;
      const state = { query, local: [] as Suggestion[], remote: fitting, completion: kept };
      last.current = state;
      setCompletion(kept ? { ...kept, typed: value } : null);
      setItems(merge(query, [], fitting, kept));

      void api.suggestLocal(query).then((found) => {
        if (id !== request.current) return;
        state.local = found.suggestions;
        state.completion = complete && found.completion && continues(found.completion, value) ? found.completion : null;
        setCompletion(state.completion ? { ...state.completion, typed: value } : null);
        setItems(merge(query, state.local, state.remote, state.completion));
      });
      timer.current = window.setTimeout(() => {
        void api.suggestRemote(query).then((remote) => {
          if (id !== request.current) return;
          state.remote = remote;
          setItems(merge(query, state.local, state.remote, state.completion));
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
      if (next < 0) return typed;
      const suggestion = items[next];
      // A site shows as its name, the way it would be typed.
      return suggestion.kind === 'search' ? suggestion.text : displayUrl(suggestion.url);
    },
    [items, selected],
  );

  return { items, selected, completion, ask, clear, move };
}

/**
 * A text field with suggestions and completion: the address bar and the home page's search
 * field are both one of these. `go` is called with what to open (an address or a search).
 *
 * Typing the start of a site the user goes to often fills in the rest, selected, so the next
 * letter replaces it and Enter opens the site.
 */
export function useTypeahead(input: RefObject<HTMLInputElement | null>, go: (value: string) => void) {
  const { items, selected, completion, ask, clear, move } = useSuggestions();
  const [text, setText] = useState('');
  /** What the user typed themselves (the field can show a completion or a picked suggestion). */
  const typed = useRef('');
  /** The completed text waiting to be shown, and from where its added part starts. */
  const pending = useRef<{ text: string; from: number } | null>(null);

  // A completion arrived for what is in the field: show the rest of the name, selected, so
  // the next letter typed replaces it.
  useLayoutEffect(() => {
    const field = input.current;
    if (!completion || !field || document.activeElement !== field || typed.current !== completion.typed || selected >= 0) return;
    const full = completion.typed + completion.text.slice(completion.typed.length);
    if (field.value === full && field.selectionEnd === full.length) return;
    pending.current = { text: full, from: completion.typed.length };
    setText(full);
  }, [completion, input, selected]);
  // The selection can only be made once the field holds the completed text, which is a
  // render after it was asked for.
  useLayoutEffect(() => {
    const field = input.current;
    if (!pending.current || !field || field.value !== pending.current.text) return;
    field.setSelectionRange(pending.current.from, pending.current.text.length);
    pending.current = null;
  }, [text, input]);

  const submit = (value: string) => {
    clear();
    go(value);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const native = event.nativeEvent as InputEvent;
    pending.current = null;
    setText(value);
    typed.current = value;
    // Completing is for letters typed at the end: not while deleting, pasting, changing the
    // middle, or while a word is still being composed (as in Japanese input).
    ask(value, native.inputType === 'insertText' && !native.isComposing && event.target.selectionStart === value.length);
  };

  /** Returns true when the key was handled here. */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): boolean => {
    if (event.key === 'Enter') {
      const shown = event.currentTarget.value;
      const completed = completion && shown.toLowerCase() === (completion.typed + completion.text.slice(completion.typed.length)).toLowerCase();
      submit(selected >= 0 ? valueOf(items[selected]) : completed ? completion.url : shown);
      return true;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault();
      setText(move(event.key === 'ArrowDown' ? 1 : -1, typed.current));
      return true;
    }
    return false;
  };

  /** Puts `value` in the field and forgets what was being typed (another tab, another page). */
  const reset = useCallback(
    (value: string) => {
      setText(value);
      typed.current = '';
      clear();
    },
    [clear],
  );

  return { text, typed, items, selected, onChange, onKeyDown, submit, reset, clear };
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
            {suggestion.kind === 'search' ? (
              <Completed text={suggestion.text} typed={typed} />
            ) : suggestion.kind === 'site' && suggestion.title ? (
              <Completed text={suggestion.title} typed={typed} />
            ) : (
              suggestion.title || displayUrl(suggestion.url)
            )}
          </span>
          {suggestion.kind !== 'search' && suggestion.kind !== 'site' && suggestion.title ? <span className="suggestion-url">{displayUrl(suggestion.url)}</span> : null}
          {index === 0 ? <span className="suggestion-hint">{suggestion.kind === 'search' ? 'Search' : 'Open'}</span> : null}
        </li>
      ))}
    </ul>
  );
}
