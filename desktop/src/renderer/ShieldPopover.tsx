import { displayHost, siteKey } from '../../../src/browser/url';
import type { EngineStatus, Panel, Settings, TabState } from '../shared/types';
import { api } from './api';
import { Toggle } from './controls';

type Props = {
  tab: TabState;
  settings: Settings;
  totalBlocked: number;
  engine: EngineStatus | null;
  /** On its way out (it is animating closed). */
  leaving: boolean;
  onClose: () => void;
  onOpenPanel: (panel: Panel) => void;
};

/** What Shields are doing on the page in front, and the switch for this site. */
export function ShieldPopover({ tab, settings, totalBlocked, engine, leaving, onClose, onOpenPanel }: Props) {
  const site = /^https?:/i.test(tab.url) ? siteKey(tab.url) : '';
  const everywhere = settings.shields.enabled;
  const onHere = everywhere && !settings.disabledSites.includes(site);
  const popupsAllowed = settings.popupSites.includes(site);

  return (
    <div className={`popover shield-popover${leaving ? ' leaving' : ''}`} role="dialog" aria-label="Shields">
      {!everywhere ? (
        <>
          <p className="popover-title">Shields are off everywhere</p>
          <p className="muted">Ads and trackers are not being blocked on any site.</p>
          <button className="button primary" onClick={() => void api.setSettings({ shields: { ...settings.shields, enabled: true } }).then(() => api.reload())}>
            Turn Shields on
          </button>
        </>
      ) : site ? (
        <>
          <div className="row">
            <div className="row-text">
              <p className="popover-title">{onHere ? 'Shields are on' : 'Shields are off'}</p>
              <p className="muted">for {site}</p>
            </div>
            <Toggle
              label={`Shields for ${site}`}
              checked={onHere}
              onChange={(next) => {
                // The page is loaded again so the change shows right away.
                void api.setSiteShields(site, next).then(() => api.reload());
                onClose();
              }}
            />
          </div>
          <div className="stat">
            <span className="stat-number">{onHere ? tab.blocked.toLocaleString() : '—'}</span>
            <span className="muted">{onHere ? 'ads and trackers blocked on this page' : 'Nothing is blocked on this site.'}</span>
          </div>
        </>
      ) : (
        <>
          <p className="popover-title">Shields are on</p>
          <p className="muted">Open a page to see what is blocked on it.</p>
        </>
      )}
      {site && (tab.popupsBlocked > 0 || popupsAllowed) ? (
        <div className="popover-section">
          {tab.popupsBlocked > 0 ? (
            <div className="row">
              <div className="row-text">
                <p className="row-title">
                  {tab.popupsBlocked === 1 ? '1 pop-up stopped' : `${tab.popupsBlocked.toLocaleString()} pop-ups stopped`}
                </p>
                <p className="muted">{tab.lastPopup ? `Last: ${displayHost(tab.lastPopup)}` : 'This page tried to open other windows.'}</p>
              </div>
              {tab.lastPopup ? (
                <button
                  className="button"
                  onClick={() => {
                    void api.openBlockedPopup();
                    onClose();
                  }}>
                  Open
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="row">
            <div className="row-text">
              <p className="row-title">Allow pop-ups from {site}</p>
            </div>
            <Toggle label={`Allow pop-ups from ${site}`} checked={popupsAllowed} onChange={(next) => void api.setSitePopups(site, next)} />
          </div>
        </div>
      ) : null}
      <button className="link" onClick={() => onOpenPanel('privacy')}>
        {totalBlocked.toLocaleString()} blocked in total · Privacy report
      </button>
      {engine?.lastError ? <p className="warn-text">Filters could not be loaded: {engine.lastError}</p> : null}
    </div>
  );
}
