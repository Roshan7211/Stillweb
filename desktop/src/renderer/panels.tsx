// The side panels: Settings, History, Bookmarks, Downloads, Privacy report and About.
import { FolderOpen, HardDrive, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';

import { SEARCH_ENGINES, displayUrl, type SearchEngineId } from '../../../src/browser/url';
import type { AboutInfo, Bookmark, DownloadState, EngineStatus, FilterListInfo, HistoryEntry, LicenseData, Panel, PrivacyReport, Settings } from '../shared/types';
import { api } from './api';
import { Row, Section, Toggle } from './controls';
import { LOGO } from './logo';

const TITLES: Record<Panel, string> = {
  settings: 'Settings',
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
  privacy: 'Privacy report',
  about: 'About Stillweb',
};

type SheetProps = { panel: Panel; leaving: boolean; settings: Settings; engine: EngineStatus | null; isPrivate: boolean; onClose: () => void };

export function PanelSheet({ panel, leaving, settings, engine, isPrivate, onClose }: SheetProps) {
  return (
    <aside className={`sheet${leaving ? ' leaving' : ''}`} role="dialog" aria-label={TITLES[panel]}>
      <header className="sheet-header">
        <h2>{TITLES[panel]}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="sheet-body" key={panel}>
        {panel === 'settings' ? <SettingsPanel settings={settings} engine={engine} /> : null}
        {panel === 'history' ? <HistoryPanel onClose={onClose} isPrivate={isPrivate} /> : null}
        {panel === 'bookmarks' ? <BookmarksPanel onClose={onClose} /> : null}
        {panel === 'downloads' ? <DownloadsPanel /> : null}
        {panel === 'privacy' ? <PrivacyPanel /> : null}
        {panel === 'about' ? <AboutPanel engine={engine} /> : null}
      </div>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="empty muted">{children}</p>;
}

// ---------------------------------------------------------------------------

function SettingsPanel({ settings, engine }: { settings: Settings; engine: EngineStatus | null }) {
  const [lists, setLists] = useState<FilterListInfo[]>([]);
  const [updateNote, setUpdateNote] = useState('');
  const [view, setView] = useState<'general' | 'advanced'>('general');
  /** Clearing takes two presses: 'ask' is after the first. */
  const [clearing, setClearing] = useState<'idle' | 'ask' | 'done'>('idle');
  const shields = settings.shields;
  const setShield = (patch: Partial<Settings['shields']>) => void api.setSettings({ shields: { ...shields, ...patch } });

  useEffect(() => {
    void api.getFilterLists().then(setLists);
  }, [settings.disabledLists, shields.hideCookieBanners]);

  return (
    <>
      {/* Everyday settings first; blocking has its own tab, for those who want to tune it. */}
      <div className="segmented wide" role="tablist" aria-label="Settings">
        <button role="tab" aria-selected={view === 'general'} className={view === 'general' ? 'on' : undefined} onClick={() => setView('general')}>
          General
        </button>
        <button role="tab" aria-selected={view === 'advanced'} className={view === 'advanced' ? 'on' : undefined} onClick={() => setView('advanced')}>
          Advanced
        </button>
      </div>

      {view === 'general' ? (
        <>
          <Section title="Search">
            <Row title="Search engine">
              <select
                aria-label="Search engine"
                value={settings.searchEngine}
                onChange={(event) => void api.setSettings({ searchEngine: event.target.value as SearchEngineId })}>
                {SEARCH_ENGINES.map((engineOption) => (
                  <option key={engineOption.id} value={engineOption.id}>
                    {engineOption.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </Row>
            {settings.searchEngine === 'custom' ? (
              <Row title="Search address" detail="Use %s where the search words go.">
                <input
                  className="text-input"
                  aria-label="Custom search address"
                  placeholder="https://example.com/search?q=%s"
                  defaultValue={settings.customSearchTemplate}
                  onBlur={(event) => void api.setSettings({ customSearchTemplate: event.target.value.trim() })}
                />
              </Row>
            ) : null}
            <Row title="Search suggestions" detail="Sends what you type to the search engine, without cookies. Never in private windows.">
              <Toggle label="Search suggestions" checked={settings.searchSuggestions} onChange={(next) => void api.setSettings({ searchSuggestions: next })} />
            </Row>
          </Section>

          <Section title="Appearance">
            <Row title="Theme">
              <div className="segmented" role="radiogroup" aria-label="Theme">
                {(['system', 'light', 'dark'] as const).map((theme) => (
                  <button key={theme} role="radio" aria-checked={settings.theme === theme} className={settings.theme === theme ? 'on' : undefined} onClick={() => void api.setSettings({ theme })}>
                    {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          <Section title="Startup and privacy">
            <Row title="Reopen tabs from last time">
              <Toggle label="Reopen tabs from last time" checked={settings.restoreTabs} onChange={(next) => void api.setSettings({ restoreTabs: next })} />
            </Row>
            <Row title="Clear browsing data when quitting" detail="History, cookies and site data are deleted every time you quit.">
              <Toggle label="Clear browsing data when quitting" checked={settings.clearDataOnExit} onChange={(next) => void api.setSettings({ clearDataOnExit: next })} />
            </Row>
            <Row title="Clear browsing data now" detail="Deletes history, cookies, cache and site data. Bookmarks are kept.">
              <button
                className="button danger"
                disabled={clearing === 'done'}
                onBlur={() => setClearing((state) => (state === 'ask' ? 'idle' : state))}
                onClick={() => {
                  if (clearing === 'idle') setClearing('ask');
                  else if (clearing === 'ask') void api.clearBrowsingData().then(() => setClearing('done'));
                }}>
                {clearing === 'ask' ? 'Press again to clear' : clearing === 'done' ? 'Cleared' : 'Clear'}
              </button>
            </Row>
          </Section>
        </>
      ) : (
        <>
          <Section title="Shields">
            <Row title="Block ads and trackers" detail="Turn off for one site from the shield button in the toolbar.">
              <Toggle label="Block ads and trackers" checked={shields.enabled} onChange={(next) => setShield({ enabled: next })} />
            </Row>
            <Row title="Hide leftover ad spaces" detail="Removes the empty boxes and banners that blocked ads leave behind.">
              <Toggle label="Hide leftover ad spaces" checked={shields.cosmeticFiltering} disabled={!shields.enabled} onChange={(next) => setShield({ cosmeticFiltering: next })} />
            </Row>
            <Row title="Block pop-ups" detail="Stops windows a page opens by itself, and windows to other sites opened by clicking on a video.">
              <Toggle label="Block pop-ups" checked={shields.blockPopups} disabled={!shields.enabled} onChange={(next) => setShield({ blockPopups: next })} />
            </Row>
            <Row title="Block third-party cookies" detail="Other sites embedded in a page can’t use cookies to follow you.">
              <Toggle label="Block third-party cookies" checked={shields.blockThirdPartyCookies} disabled={!shields.enabled} onChange={(next) => setShield({ blockThirdPartyCookies: next })} />
            </Row>
            <Row title="Use secure connections" detail="Opens sites over HTTPS when they support it.">
              <Toggle label="Use secure connections" checked={shields.httpsUpgrade} onChange={(next) => setShield({ httpsUpgrade: next })} />
            </Row>
          </Section>

          <Section title="Filter lists">
            {lists.map((list) => (
              <Row key={list.id} title={list.title} detail={list.purpose}>
                <Toggle label={list.title} checked={list.enabled} disabled={!shields.enabled} onChange={(next) => void api.setFilterListEnabled(list.id, next)} />
              </Row>
            ))}
            <Row
              title="Filter version"
              detail={
                engine?.lastError
                  ? `Could not be loaded: ${engine.lastError}`
                  : engine?.version
                    ? `${new Date(engine.version).toLocaleString()} (${engine.source === 'downloaded' ? 'downloaded' : 'built in'})${updateNote ? ` · ${updateNote}` : ''}`
                    : 'Loading…'
              }>
              <button
                className="button"
                onClick={() => {
                  setUpdateNote('Checking…');
                  api.checkFilterUpdate().then(setUpdateNote, (error: Error) => setUpdateNote(error.message));
                }}>
                Check for updates
              </button>
            </Row>
          </Section>

          {settings.disabledSites.length > 0 ? (
            <Section title="Sites with Shields off">
              {settings.disabledSites.map((site) => (
                <Row key={site} title={site}>
                  <button className="button" onClick={() => void api.setSiteShields(site, true)}>
                    Turn on
                  </button>
                </Row>
              ))}
            </Section>
          ) : null}

          {settings.popupSites.length > 0 ? (
            <Section title="Sites that may open pop-ups">
              {settings.popupSites.map((site) => (
                <Row key={site} title={site}>
                  <button className="button" onClick={() => void api.setSitePopups(site, false)}>
                    Remove
                  </button>
                </Row>
              ))}
            </Section>
          ) : null}

        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function dayLabel(time: number): string {
  const day = new Date(time);
  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function HistoryPanel({ onClose, isPrivate }: { onClose: () => void; isPrivate: boolean }) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const load = useCallback(() => void api.getHistory(query).then(setEntries), [query]);
  useEffect(load, [load]);

  let lastDay = '';
  return (
    <>
      <input className="text-input wide" aria-label="Search history" placeholder="Search history" value={query} onChange={(event) => setQuery(event.target.value)} />
      {isPrivate ? <p className="muted note">Pages opened in this private window are not added to history.</p> : null}
      {entries && entries.length === 0 ? <Empty>{query ? 'Nothing in your history matches.' : 'Pages you visit will be listed here.'}</Empty> : null}
      <ul className="list">
        {(entries ?? []).map((entry) => {
          const label = dayLabel(entry.time);
          const heading = label !== lastDay ? <li className="list-heading">{label}</li> : null;
          lastDay = label;
          return (
            <Fragment key={`${entry.time}:${entry.url}`}>
              {heading}
              <li className="list-item">
                <button
                  className="list-main"
                  title={entry.url}
                  onClick={() => {
                    void api.navigate(entry.url);
                    onClose();
                  }}>
                  <span className="list-title">{entry.title || displayUrl(entry.url)}</span>
                  <span className="list-detail muted">
                    {new Date(entry.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {displayUrl(entry.url)}
                  </span>
                </button>
                <button className="icon-button small" aria-label="Remove from history" onClick={() => void api.removeHistory(entry.url, entry.time).then(load)}>
                  <X size={15} />
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}

function BookmarksPanel({ onClose }: { onClose: () => void }) {
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  useEffect(() => {
    void api.getBookmarks().then(setBookmarks);
    return api.on('bookmarks', setBookmarks);
  }, []);
  return (
    <>
      {bookmarks && bookmarks.length === 0 ? <Empty>Use the star in the address bar to bookmark a page.</Empty> : null}
      <ul className="list">
        {[...(bookmarks ?? [])].reverse().map((bookmark) => (
          <li key={bookmark.url} className="list-item">
            <button
              className="list-main"
              title={bookmark.url}
              onClick={() => {
                void api.navigate(bookmark.url);
                onClose();
              }}>
              <span className="list-title">{bookmark.title}</span>
              <span className="list-detail muted">{displayUrl(bookmark.url)}</span>
            </button>
            <button className="icon-button small" aria-label="Remove bookmark" onClick={() => void api.setBookmarked(bookmark.url, bookmark.title, false)}>
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function DownloadsPanel() {
  const [downloads, setDownloads] = useState<DownloadState[] | null>(null);
  useEffect(() => {
    void api.getDownloads().then(setDownloads);
    return api.on('downloads', setDownloads);
  }, []);
  const status = (d: DownloadState) =>
    d.state === 'progressing'
      ? d.total > 0
        ? `${size(d.received)} of ${size(d.total)}`
        : size(d.received)
      : d.state === 'completed'
        ? size(d.received)
        : d.state === 'cancelled'
          ? 'Cancelled'
          : 'Failed';
  return (
    <>
      {downloads && downloads.length === 0 ? <Empty>Files you download are saved to your Downloads folder and listed here.</Empty> : null}
      <ul className="list">
        {(downloads ?? []).map((d) => (
          <li key={d.id} className="list-item">
            <button className="list-main" title={d.path} disabled={d.state !== 'completed'} onClick={() => void api.openDownload(d.id)}>
              <span className="list-title">{d.filename}</span>
              <span className="list-detail muted">{status(d)}</span>
              {d.state === 'progressing' ? (
                <progress className="progress" aria-label={`Downloading ${d.filename}`} max={d.total || undefined} value={d.total ? d.received : undefined} />
              ) : null}
            </button>
            {d.state === 'progressing' ? (
              <button className="icon-button small" aria-label="Cancel download" onClick={() => void api.cancelDownload(d.id)}>
                <X size={15} />
              </button>
            ) : d.state === 'completed' ? (
              <button className="icon-button small" aria-label="Show in folder" title="Show in folder" onClick={() => void api.showDownload(d.id)}>
                <FolderOpen size={15} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {downloads && downloads.some((d) => d.state !== 'progressing') ? (
        <button className="button" onClick={() => void api.clearDownloads()}>
          Clear list
        </button>
      ) : null}
    </>
  );
}

function PrivacyPanel() {
  const [report, setReport] = useState<PrivacyReport | null>(null);
  const load = useCallback(() => void api.getPrivacyReport().then(setReport), []);
  useEffect(load, [load]);
  if (!report) return null;
  const peak = Math.max(1, ...report.days.map((d) => d.count));
  const top = Math.max(1, ...report.hosts.map((h) => h.count));
  const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <>
      <div className="card stat-block">
        <span className="stat-number large">{report.totalBlocked.toLocaleString()}</span>
        <span className="muted">ads and trackers blocked since you started using Stillweb</span>
      </div>

      <Section title="Last 14 days">
        <div className="chart" role="img" aria-label={`Blocked per day over the last 14 days, at most ${peak.toLocaleString()} in a day`}>
          {report.days.map((d) => (
            <div key={d.day} className="chart-column" title={`${shortDay(d.day)}: ${d.count.toLocaleString()} blocked`}>
              <div className="chart-bar" style={{ height: `${Math.max(d.count > 0 ? 3 : 0, (d.count / peak) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="chart-axis muted">
          <span>{shortDay(report.days[0].day)}</span>
          <span>Most in a day: {peak === 1 && report.totalBlocked === 0 ? 0 : peak.toLocaleString()}</span>
          <span>Today</span>
        </div>
      </Section>

      <Section title="Blocked most often">
        {report.hosts.length === 0 ? <Empty>Nothing has been blocked yet.</Empty> : null}
        {report.hosts.map((h) => (
          <div key={h.host} className="host-row">
            <span className="host-name">{h.host}</span>
            <span className="host-bar">
              <span style={{ width: `${(h.count / top) * 100}%` }} />
            </span>
            <span className="host-count">{h.count.toLocaleString()}</span>
          </div>
        ))}
      </Section>

      <button className="button" onClick={() => void api.resetPrivacyReport().then(load)}>
        Reset report
      </button>
    </>
  );
}

function AboutPanel({ engine }: { engine: EngineStatus | null }) {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [licenses, setLicenses] = useState<LicenseData | null>(null);
  const [lists, setLists] = useState<FilterListInfo[]>([]);
  useEffect(() => {
    void api.getAbout().then(setAbout);
    void api.getFilterLists().then(setLists);
    // Loaded up front, so opening "Open-source licenses" shows them at once.
    void api.getLicenses().then(setLicenses);
  }, []);
  const filtersDate = engine?.version ? new Date(engine.version).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return (
    <>
      <div className="about-head">
        <img className="about-logo" src={LOGO} alt="" draggable={false} />
        <h3 className="about-name">Stillweb</h3>
        <p className="muted">A quieter web. Ads, trackers and pop-ups are stopped before they load.</p>
        <span className="about-version">Version {about?.version ?? '…'}</span>
      </div>

      <div className="card about-facts">
        <div className="fact">
          <span className="muted">Browser engine</span>
          <span>Chromium {about?.chromium.split('.')[0] ?? '…'}</span>
        </div>
        <div className="fact">
          <span className="muted">Filters</span>
          <span>{engine?.lastError ? 'Not loaded' : (filtersDate ?? 'Loading…')}</span>
        </div>
        <div className="fact">
          <span className="muted">Filter lists in use</span>
          <span>{lists.filter((list) => list.enabled).length}</span>
        </div>
      </div>

      <Section title="Your privacy">
        <ul className="about-points">
          <li>
            <ShieldCheck size={16} />
            <span>Stillweb has no account and collects nothing about you or the pages you visit.</span>
          </li>
          <li>
            <Search size={16} />
            <span>Search suggestions, when they are on, send what you type to your search engine, without cookies.</span>
          </li>
          <li>
            <HardDrive size={16} />
            <span>History, bookmarks and settings stay on this computer.</span>
          </li>
        </ul>
        {about?.privacyUrl ? (
          <Row title="Privacy policy">
            <button className="button" onClick={() => void api.newTab(about.privacyUrl!)}>
              Open
            </button>
          </Row>
        ) : null}
      </Section>

      <Section title="Credits">
        <details className="license">
          <summary>
            Filter lists <span className="muted">{lists.length} lists</span>
          </summary>
          <div className="credit-list">
            {lists.map((list) => (
              <div key={list.id} className="credit">
                <span>{list.title}</span>
                <span className="muted">{list.homepage ? `${list.license} · ${displayUrl(list.homepage)}` : list.license}</span>
              </div>
            ))}
            <p className="muted note">The lists are the work of their authors and volunteers, and are used under the licenses shown.</p>
          </div>
        </details>
        <details className="license">
          <summary>
            Open-source licenses <span className="muted">{licenses ? `${licenses.components.length} components` : ''}</span>
          </summary>
          <div className="credit-list">
            {(licenses?.components ?? []).map((component) => (
              <details key={component.name} className="license inner">
                <summary>
                  {component.name} <span className="muted">{component.license}</span>
                </summary>
                <pre>{component.text}</pre>
              </details>
            ))}
            {Object.entries(licenses?.texts ?? {}).map(([id, text]) => (
              <details key={id} className="license inner">
                <summary>{id} license text</summary>
                <pre>{text}</pre>
              </details>
            ))}
          </div>
        </details>
        <Row title="Chromium and its libraries" detail="Opens the notices file that ships with the app.">
          <button className="button" onClick={() => void api.openChromiumLicenses()}>
            Open
          </button>
        </Row>
      </Section>

      <p className="about-foot muted">© {new Date().getFullYear()} Stillweb</p>
    </>
  );
}
