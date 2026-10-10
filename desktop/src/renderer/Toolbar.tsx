import { ArrowLeft, ArrowRight, Clock, Download, EllipsisVertical, EyeOff, Globe, Lock, RotateCw, Search, Shield, ShieldOff, Star, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { displayUrl } from '../../../src/browser/url';
import type { Bookmark, DownloadState, Panel, Settings, Suggestion, TabState } from '../shared/types';
import { api } from './api';

type Props = {
  tab: TabState | null;
  settings: Settings;
  isPrivate: boolean;
  focusRequest: number;
  shieldOpen: boolean;
  onToggleShield: () => void;
  /** The suggestion list is showing (it is drawn over the page). */
  onSuggesting: (open: boolean) => void;
  onOpenPanel: (panel: Panel) => void;
};

function SuggestionIcon({ suggestion }: { suggestion: Suggestion }) {
  if (suggestion.kind === 'search') return <Search size={15} />;
  if (suggestion.kind === 'history') return <Clock size={15} />;
  if (suggestion.kind === 'bookmark') return <Star size={15} />;
  return <Globe size={15} />;
}

function AddressBar({ tab, isPrivate, focusRequest, onSuggesting }: Pick<Props, 'tab' | 'isPrivate' | 'focusRequest' | 'onSuggesting'>) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(-1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const url = tab?.url ?? '';
  const request = useRef(0);

  useEffect(() => {
    void api.getBookmarks().then(setBookmarks);
    return api.on('bookmarks', setBookmarks);
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  // Another tab, or another page in this one: whatever was being typed is dropped.
  useEffect(() => {
    setText(url);
    setSuggestions([]);
    setSelected(-1);
  }, [url, tab?.id]);

  const open = focused && suggestions.length > 0;
  useEffect(() => {
    onSuggesting(open);
  }, [open, onSuggesting]);

  const ask = (value: string) => {
    const id = ++request.current;
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }
    window.setTimeout(() => {
      // Only the answer to what is in the field now is shown.
      if (id !== request.current) return;
      void api.suggest(value).then((items) => {
        if (id === request.current) setSuggestions(items);
      });
    }, 90);
  };

  const go = (value: string) => {
    request.current++;
    setSuggestions([]);
    setSelected(-1);
    input.current?.blur();
    if (value.trim()) void api.navigate(value);
  };

  const valueOf = (s: Suggestion) => (s.kind === 'search' ? s.text : s.url);
  const bookmarked = !!url && bookmarks.some((b) => b.url === url);
  const isPage = /^https?:/i.test(url);

  return (
    <div className={`address${focused ? ' focused' : ''}`}>
      <span className="address-icon" title={!isPage ? undefined : tab?.secure ? 'Connection is secure' : 'Connection is not secure'}>
        {isPrivate && !isPage ? <EyeOff size={15} /> : !isPage || focused ? <Search size={15} /> : tab?.secure ? <Lock size={14} /> : <TriangleAlert size={15} className="warn" />}
      </span>
      <input
        ref={input}
        className="address-input"
        aria-label="Address and search"
        placeholder="Search or enter address"
        spellCheck={false}
        autoComplete="off"
        value={focused ? text : displayUrl(url)}
        onFocus={(event) => {
          setFocused(true);
          setText(url);
          const element = event.currentTarget;
          // After React has put the full address in the field.
          requestAnimationFrame(() => element.select());
        }}
        onBlur={() => {
          setFocused(false);
          setSuggestions([]);
          setSelected(-1);
          request.current++;
        }}
        onChange={(event) => {
          setText(event.target.value);
          setSelected(-1);
          ask(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            go(selected >= 0 ? valueOf(suggestions[selected]) : text);
          } else if (event.key === 'Escape') {
            if (suggestions.length) {
              setSuggestions([]);
              setSelected(-1);
            } else {
              setText(url);
              input.current?.blur();
              void api.focusPage();
            }
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            // One step past either end is "nothing selected": what was typed.
            const next = ((selected + 1 + step + suggestions.length + 1) % (suggestions.length + 1)) - 1;
            setSelected(next);
            setText(next >= 0 ? valueOf(suggestions[next]) : text);
          }
        }}
      />
      {isPage && !focused ? (
        <button
          className={`icon-button small${bookmarked ? ' on' : ''}`}
          aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          aria-pressed={bookmarked}
          onClick={() => void api.setBookmarked(url, tab?.title ?? '', !bookmarked)}>
          <Star size={15} fill={bookmarked ? 'currentColor' : 'none'} />
        </button>
      ) : null}
      {open ? (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s, index) => (
            <li
              key={`${s.kind}:${valueOf(s)}`}
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'selected' : undefined}
              // Before the field's blur, which would close the list.
              onMouseDown={(event) => {
                event.preventDefault();
                go(valueOf(s));
              }}>
              <span className="suggestion-icon">
                <SuggestionIcon suggestion={s} />
              </span>
              <span className="suggestion-text">{s.kind === 'search' ? s.text : s.title || displayUrl(s.url)}</span>
              {s.kind !== 'search' ? <span className="suggestion-url">{displayUrl(s.url)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Toolbar(props: Props) {
  const { tab, settings, shieldOpen, onToggleShield, onOpenPanel } = props;
  const [downloads, setDownloads] = useState<DownloadState[]>([]);
  useEffect(() => {
    void api.getDownloads().then(setDownloads);
    return api.on('downloads', setDownloads);
  }, []);

  const isPage = !!tab && /^https?:/i.test(tab.url);
  const shieldsOn = tab ? tab.shieldsActive : settings.shields.enabled;
  const downloading = downloads.some((d) => d.state === 'progressing');

  return (
    <div className="toolbar">
      <button className="icon-button" aria-label="Back" title="Back" disabled={!tab?.canGoBack} onClick={() => void api.goBack()}>
        <ArrowLeft size={17} />
      </button>
      <button className="icon-button" aria-label="Forward" title="Forward" disabled={!tab?.canGoForward} onClick={() => void api.goForward()}>
        <ArrowRight size={17} />
      </button>
      {tab?.loading ? (
        <button className="icon-button" aria-label="Stop" title="Stop" onClick={() => void api.stop()}>
          <X size={17} />
        </button>
      ) : (
        <button className="icon-button" aria-label="Reload" title="Reload" disabled={!isPage} onClick={() => void api.reload()}>
          <RotateCw size={16} />
        </button>
      )}

      <AddressBar tab={tab} isPrivate={props.isPrivate} focusRequest={props.focusRequest} onSuggesting={props.onSuggesting} />

      <button
        className={`icon-button shield${shieldsOn ? '' : ' off'}${shieldOpen ? ' pressed' : ''}`}
        aria-label={shieldsOn ? `Shields are on, ${tab?.blocked ?? 0} blocked on this page` : 'Shields are off'}
        title="Shields"
        aria-expanded={shieldOpen}
        onClick={onToggleShield}>
        {shieldsOn ? <Shield size={17} /> : <ShieldOff size={17} />}
        {shieldsOn && tab && tab.blocked > 0 ? <span className="badge">{tab.blocked > 99 ? '99+' : tab.blocked}</span> : null}
      </button>
      {downloads.length > 0 ? (
        <button className={`icon-button${downloading ? ' busy' : ''}`} aria-label="Downloads" title="Downloads" onClick={() => onOpenPanel('downloads')}>
          <Download size={17} />
        </button>
      ) : null}
      <button
        className="icon-button"
        aria-label="Menu"
        title="Menu"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          void api.showAppMenu(box.left, box.bottom + 4);
        }}>
        <EllipsisVertical size={17} />
      </button>
    </div>
  );
}
