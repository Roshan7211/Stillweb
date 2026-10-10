// What the interface draws in place of a page: a new tab, and a page that failed to load.
import { Clock, Cpu, EyeOff, Globe, Image as ImageIcon, Link, Lock, Repeat, Search, Shuffle, Slash, Smartphone, TriangleAlert, WifiOff, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeLoadError, type LoadErrorInfo } from '../../../src/browser/loadErrors';
import { displayHost, searchUrl } from '../../../src/browser/url';
import logoSvg from '../../../assets/source/stillweb-icon.svg';
import type { EngineStatus, HomeTile, HomeTiles, LoadError, Panel, PhotoWallpaper, Settings } from '../shared/types';
import { api } from './api';
import { SuggestionList, useSuggestions, valueOf } from './suggestions';
import { WALLPAPERS, chooseWallpaper } from './wallpapers';

type NewTabProps = {
  isPrivate: boolean;
  totalBlocked: number;
  totalUpgrades: number;
  engine: EngineStatus | null;
  settings: Settings;
  /** The photos that ship with the app. */
  photos: PhotoWallpaper[];
  /** Which of them has its turn while the app is open this time. */
  photoTurn: number;
  /** The user's own picture (a data: URL), when that is the chosen background. */
  customWallpaper: string | null;
  /** Counts requests to put the cursor in the search field (a new tab was opened). */
  focusRequest: number;
  onOpenPanel: (panel: Panel) => void;
};

const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(logoSvg)}`;

/** A steady color for a site that has no icon, so its tile is still its own. */
function tint(host: string): string {
  let hash = 0;
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) % 360;
  return `hsl(${hash} 52% 42%)`;
}

/** A site's logo on a solid tile; its first letter on its own color when the site has no icon. */
function Logo({ tile, small }: { tile: HomeTile; small?: boolean }) {
  const host = displayHost(tile.url);
  const [failed, setFailed] = useState(false);
  return tile.icon && !failed ? (
    <span className={`logo${small ? ' small' : ''}`}>
      <img src={tile.icon} alt="" draggable={false} onError={() => setFailed(true)} />
    </span>
  ) : (
    <span className={`logo letter${small ? ' small' : ''}`} style={{ background: tint(host) }}>
      {(host[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** A bookmark: the site's logo and the name it was saved under. */
function Tile({ tile, onRemove }: { tile: HomeTile; onRemove: () => void }) {
  const host = displayHost(tile.url);
  return (
    <div className="tile-wrap">
      <button className="tile" title={tile.url} onClick={() => void api.navigate(tile.url)}>
        <Logo tile={tile} />
        <span className="tile-title">{tile.title && tile.title !== tile.url ? tile.title : host}</span>
      </button>
      <button className="tile-remove" aria-label={`Remove ${host} from bookmarks`} title="Remove bookmark" onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

/** An often-visited site: a small picture of its page, with its logo and address under it. */
function VisitCard({ tile }: { tile: HomeTile }) {
  const host = displayHost(tile.url);
  const [failed, setFailed] = useState(false);
  return (
    <button className="visit-card" title={tile.url} onClick={() => void api.navigate(tile.url)}>
      <span className="visit-picture">
        {tile.thumb && !failed ? <img src={tile.thumb} alt="" draggable={false} onError={() => setFailed(true)} /> : <Logo tile={tile} />}
      </span>
      <span className="visit-name">
        {tile.thumb && !failed ? <Logo tile={tile} small /> : null}
        <span>{host}</span>
      </span>
    </button>
  );
}

/** The home page's search field: the same suggestions as the address bar, right where the eye is. */
function SearchBox({ focusRequest }: { focusRequest: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const typed = useRef('');
  const { items, selected, ask, clear, move } = useSuggestions();

  useEffect(() => {
    input.current?.focus();
  }, [focusRequest]);

  const go = (value: string) => {
    clear();
    if (value.trim()) void api.navigate(value);
  };
  const open = focused && items.length > 0;

  return (
    <div className={`home-search${focused ? ' focused' : ''}${open ? ' open' : ''}`}>
      <Search size={17} />
      <input
        ref={input}
        aria-label="Search or enter address"
        placeholder="Search or enter address"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onFocus={() => setFocused(true)}
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
            go(selected >= 0 ? valueOf(items[selected]) : text);
          } else if (event.key === 'Escape') {
            if (items.length) clear();
            else input.current?.blur();
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
            event.preventDefault();
            setText(move(event.key === 'ArrowDown' ? 1 : -1, typed.current));
          }
        }}
      />
      {open ? <SuggestionList items={items} selected={selected} typed={typed.current} onPick={go} /> : null}
    </div>
  );
}

/** How much loading was avoided, as a number and its unit: about a twentieth of a second per blocked request. */
function timeSaved(blocked: number): { value: string; unit: string } {
  const seconds = blocked * 0.05;
  const plural = (count: number, unit: string) => ({ value: String(count), unit: count === 1 ? unit : `${unit}s` });
  if (seconds < 60) return plural(Math.round(seconds), 'second');
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return { value: (seconds / 3600).toFixed(1), unit: 'hours' };
  return { value: (seconds / 86400).toFixed(1), unit: 'days' };
}

export function NewTabPage({ isPrivate, totalBlocked, totalUpgrades, engine, settings, photos, photoTurn, customWallpaper, focusRequest, onOpenPanel }: NewTabProps) {
  const [tiles, setTiles] = useState<HomeTiles>({ bookmarks: [], visited: [] });
  const [choosing, setChoosing] = useState(false);
  const load = useCallback(() => void api.getHomeTiles().then(setTiles), []);
  useEffect(() => {
    load();
    // Bookmarks change, and icons and page pictures arrive while the page is open.
    const stop = [api.on('bookmarks', load), api.on('home-changed', load)];
    return () => stop.forEach((off) => off());
  }, [load]);

  const wallpaper = isPrivate ? null : chooseWallpaper(settings.wallpaper, photos, photoTurn, customWallpaper);
  const photo = wallpaper?.kind === 'photo' ? wallpaper.photo : null;
  // The photo fades in once it has been read, instead of appearing in strips.
  const [photoReady, setPhotoReady] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return;
    const image = new Image();
    image.onload = () => setPhotoReady(photo.id);
    image.src = photo.url;
    return () => {
      image.onload = null;
    };
  }, [photo]);

  const pick = (id: string) => void api.setSettings({ wallpaper: id });
  const saved = timeSaved(totalBlocked);
  const ink = wallpaper ? (wallpaper.kind === 'photo' ? 'light' : wallpaper.ink) : null;

  return (
    <div
      className={`page newtab${ink ? ` on-wallpaper ink-${ink}` : ''}${photo ? ' on-photo' : ''}`}
      style={wallpaper?.kind === 'drawn' ? { background: wallpaper.background } : undefined}>
      {photo ? <div className={`wallpaper-photo${photoReady === photo.id ? ' ready' : ''}`} style={{ backgroundImage: `url("${photo.url}")` }} /> : null}

      <div className="newtab-scroll">
        <div className="newtab-inner">
          {isPrivate ? (
            <div className="card notice">
              <EyeOff size={26} />
              <h2>Private window</h2>
              <p className="muted">
                Pages you visit here aren’t saved to history, and their cookies and site data are deleted when you close all private windows.
                Private windows keep their own cookies, separate from normal windows.
              </p>
            </div>
          ) : (
            <div className="brand">
              <img className="brand-logo" src={LOGO} alt="" draggable={false} />
              <h1 className="wordmark">Stillweb</h1>
            </div>
          )}

          <SearchBox focusRequest={focusRequest} />

          <button className="stats" onClick={() => onOpenPanel('privacy')} title="Open the privacy report">
            <span className="stat-item">
              <span className="stat-value">{totalBlocked.toLocaleString()}</span>
              <span className="stat-name">Ads and trackers blocked</span>
            </span>
            <span className="stat-item" title="An estimate: about a twentieth of a second for every ad or tracker that did not load.">
              <span className="stat-value">
                {saved.value} <small>{saved.unit}</small>
              </span>
              <span className="stat-name">Time saved (estimate)</span>
            </span>
            <span className="stat-item" title="Pages that were opened over a secure connection because Stillweb asked for one.">
              <span className="stat-value">{totalUpgrades.toLocaleString()}</span>
              <span className="stat-name">Connections made secure</span>
            </span>
          </button>
          {engine?.lastError ? <p className="warn-text">Filters could not be loaded, so nothing is being blocked: {engine.lastError}</p> : null}

          {tiles.bookmarks.length > 0 ? (
            <section className="tile-section">
              <h2>Bookmarks</h2>
              <div className="tiles">
                {tiles.bookmarks.map((tile) => (
                  <Tile key={tile.url} tile={tile} onRemove={() => void api.setBookmarked(tile.url, tile.title, false)} />
                ))}
              </div>
            </section>
          ) : null}
          {tiles.visited.length > 0 ? (
            <section className="tile-section">
              <h2>Often visited</h2>
              <div className="visits">
                {tiles.visited.map((tile) => (
                  <VisitCard key={tile.url} tile={tile} />
                ))}
              </div>
            </section>
          ) : null}
          {!isPrivate && tiles.bookmarks.length === 0 && tiles.visited.length === 0 ? (
            <p className="hint">Sites you bookmark with the star, and the ones you visit most, will appear here.</p>
          ) : null}
        </div>
      </div>

      {photo ? (
        <button className="photo-credit" title="Open the photo's page" onClick={() => void api.newTab(photo.page)}>
          Photo by {photo.author} on {photo.source}
        </button>
      ) : null}

      {isPrivate ? null : (
        <div className="customize">
          {choosing ? (
            <div className="wallpaper-picker" role="dialog" aria-label="Background">
              <h3>Photos</h3>
              <div className="swatches">
                <button className={`swatch plain${settings.wallpaper === 'photos' ? ' on' : ''}`} aria-pressed={settings.wallpaper === 'photos'} title="A different photo each time you open Stillweb" onClick={() => pick('photos')}>
                  <Shuffle size={14} />
                </button>
                {photos.map((option) => (
                  <button
                    key={option.id}
                    className={`swatch${settings.wallpaper === option.id ? ' on' : ''}`}
                    style={{ backgroundImage: `url("${option.thumb}")` }}
                    aria-label={`${option.title}, photo by ${option.author}`}
                    aria-pressed={settings.wallpaper === option.id}
                    title={`${option.title} · photo by ${option.author}`}
                    onClick={() => pick(option.id)}
                  />
                ))}
              </div>
              <h3>Colours</h3>
              <div className="swatches">
                {WALLPAPERS.map((option) => (
                  <button
                    key={option.id}
                    className={`swatch${settings.wallpaper === option.id ? ' on' : ''}`}
                    style={{ background: option.background }}
                    aria-label={option.name}
                    aria-pressed={settings.wallpaper === option.id}
                    title={option.name}
                    onClick={() => pick(option.id)}
                  />
                ))}
                <button className={`swatch plain${settings.wallpaper === 'none' ? ' on' : ''}`} aria-pressed={settings.wallpaper === 'none'} title="No background" onClick={() => pick('none')}>
                  None
                </button>
              </div>
              <button className="button" onClick={() => void api.chooseWallpaper()}>
                <ImageIcon size={14} /> Use your own picture…
              </button>
            </div>
          ) : null}
          <button className="customize-button" aria-expanded={choosing} onClick={() => setChoosing((open) => !open)}>
            <ImageIcon size={14} /> Background
          </button>
        </div>
      )}
    </div>
  );
}

const ERROR_ICONS: Record<LoadErrorInfo['icon'], LucideIcon> = {
  'wifi-off': WifiOff,
  smartphone: Smartphone,
  search: Search,
  clock: Clock,
  slash: Slash,
  lock: Lock,
  repeat: Repeat,
  link: Link,
  'alert-triangle': TriangleAlert,
  cpu: Cpu,
};

export function ErrorPage({ error, settings }: { error: LoadError; settings: Settings }) {
  // The descriptions come from the mobile apps; their numeric codes belong to other web
  // views, so only Chromium's error name is passed on.
  const info = describeLoadError({ url: error.url, code: 0, description: error.description });
  const Icon = ERROR_ICONS[info.icon] ?? Globe;
  const body = info.kind === 'offline' ? 'Check your network connection, then try again.' : info.body;
  const host = displayHost(error.url);
  return (
    <div className="page errorpage">
      <div className="error-inner">
        <Icon size={40} className="muted-icon" />
        <h1>{info.title}</h1>
        <p className="muted">{body}</p>
        <div className="actions">
          <button className="button primary" onClick={() => void api.reload()}>
            Try again
          </button>
          {info.canSearch && host ? (
            <button className="button" onClick={() => void api.navigate(searchUrl(host, settings.searchEngine, settings.customSearchTemplate))}>
              Search for {host}
            </button>
          ) : null}
        </div>
        <p className="error-code muted">{error.description || `Error ${error.code}`}</p>
      </div>
    </div>
  );
}
