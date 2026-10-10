import { AppWindow, ArrowLeft, ArrowRight, Download, EllipsisVertical, EyeOff, Lock, RotateCw, Search, Shield, ShieldOff, Star, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { displayUrl } from '../../../src/browser/url';
import type { Bookmark, DownloadState, Panel, Settings, TabState } from '../shared/types';
import { api } from './api';
import { SuggestionList, useSuggestions, valueOf } from './suggestions';

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

function AddressBar({ tab, isPrivate, focusRequest, onSuggesting, onShowBlockedPopups }: Pick<Props, 'tab' | 'isPrivate' | 'focusRequest' | 'onSuggesting'> & { onShowBlockedPopups: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');
  /** What the user typed themselves (the field can show a suggestion picked with the arrow keys). */
  const typed = useRef('');
  const { items: suggestions, selected, ask, clear, move } = useSuggestions();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const url = tab?.url ?? '';

  useEffect(() => {
    void api.getBookmarks().then(setBookmarks);
    return api.on('bookmarks', setBookmarks);
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  // Another tab: whatever was being typed is dropped. Another address in the same tab (a
  // redirect, a page changing its own address) must not wipe out what is being typed.
  const tabId = tab?.id;
  const shownTab = useRef(tabId);
  useEffect(() => {
    const sameTab = shownTab.current === tabId;
    shownTab.current = tabId;
    if (sameTab && document.activeElement === input.current) return;
    setText(url);
    clear();
  }, [url, tabId, clear]);

  const open = focused && suggestions.length > 0;
  useEffect(() => {
    onSuggesting(open);
  }, [open, onSuggesting]);

  const go = (value: string) => {
    clear();
    input.current?.blur();
    if (value.trim()) void api.navigate(value);
  };

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
          const element = event.currentTarget;
          // The full address goes into the field and is selected before anything else can
          // happen, so a key pressed right after the shortcut replaces it and is not lost.
          flushSync(() => {
            setFocused(true);
            setText(url);
          });
          element.select();
        }}
        onBlur={() => {
          setFocused(false);
          clear();
        }}
        onChange={(event) => {
          setText(event.target.value);
          typed.current = event.target.value;
          ask(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            go(selected >= 0 ? valueOf(suggestions[selected]) : text);
          } else if (event.key === 'Escape') {
            if (suggestions.length) {
              clear();
            } else {
              setText(url);
              input.current?.blur();
              void api.focusPage();
            }
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
            event.preventDefault();
            setText(move(event.key === 'ArrowDown' ? 1 : -1, typed.current));
          }
        }}
      />
      {isPage && !focused && tab && tab.popupsBlocked > 0 ? (
        <button className="chip" title="See what was stopped, or allow pop-ups from this site" onClick={onShowBlockedPopups}>
          <AppWindow size={13} />
          {tab.popupsBlocked === 1 ? 'Pop-up stopped' : `${tab.popupsBlocked} pop-ups stopped`}
        </button>
      ) : null}
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
      {open ? <SuggestionList items={suggestions} selected={selected} typed={typed.current} onPick={go} /> : null}
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
      <div className={`loading-line${tab?.loading ? ' on' : ''}`} aria-hidden="true" />
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

      <AddressBar
        tab={tab}
        isPrivate={props.isPrivate}
        focusRequest={props.focusRequest}
        onSuggesting={props.onSuggesting}
        onShowBlockedPopups={() => {
          if (!shieldOpen) onToggleShield();
        }}
      />

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
