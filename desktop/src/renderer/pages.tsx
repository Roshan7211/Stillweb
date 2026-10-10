// What the interface draws in place of a page: a new tab, and a page that failed to load.
import { Clock, Cpu, EyeOff, Globe, Link, Lock, Repeat, Search, Shield, Slash, Smartphone, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { describeLoadError, type LoadErrorInfo } from '../../../src/browser/loadErrors';
import { displayHost, searchUrl } from '../../../src/browser/url';
import type { EngineStatus, LoadError, Panel, Settings } from '../shared/types';
import { api } from './api';

type NewTabProps = { isPrivate: boolean; totalBlocked: number; engine: EngineStatus | null; onOpenPanel: (panel: Panel) => void };

export function NewTabPage({ isPrivate, totalBlocked, engine, onOpenPanel }: NewTabProps) {
  const [sites, setSites] = useState<{ url: string; title: string }[]>([]);
  useEffect(() => {
    void api.getTopSites().then(setSites);
  }, []);

  return (
    <div className="page newtab">
      <div className="newtab-inner">
        {isPrivate ? (
          <div className="card notice">
            <EyeOff size={26} />
            <h2>Private window</h2>
            <p className="muted">
              Pages you visit here aren’t saved to history, and their cookies and site data are deleted when you close all private windows. Private
              windows keep their own cookies, separate from normal windows.
            </p>
          </div>
        ) : (
          <h1 className="wordmark">Stillweb</h1>
        )}

        <button className="card stat-card" onClick={() => onOpenPanel('privacy')}>
          <Shield size={22} />
          <span className="stat-number">{totalBlocked.toLocaleString()}</span>
          <span className="muted">ads and trackers blocked</span>
        </button>
        {engine?.lastError ? <p className="warn-text">Filters could not be loaded, so nothing is being blocked: {engine.lastError}</p> : null}

        {sites.length > 0 ? (
          <div className="tiles">
            {sites.map((site) => (
              <button key={site.url} className="tile" title={site.url} onClick={() => void api.navigate(site.url)}>
                <span className="tile-letter">{(displayHost(site.url)[0] ?? '?').toUpperCase()}</span>
                <span className="tile-title">{displayHost(site.url)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
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
