import { siteKey } from '../../../src/browser/url';
import type { EngineStatus, Panel, Settings, TabState } from '../shared/types';
import { api } from './api';
import { Toggle } from './controls';

type Props = {
  tab: TabState;
  settings: Settings;
  totalBlocked: number;
  engine: EngineStatus | null;
  onClose: () => void;
  onOpenPanel: (panel: Panel) => void;
};

/** What Shields are doing on the page in front, and the switch for this site. */
export function ShieldPopover({ tab, settings, totalBlocked, engine, onClose, onOpenPanel }: Props) {
  const site = /^https?:/i.test(tab.url) ? siteKey(tab.url) : '';
  const everywhere = settings.shields.enabled;
  const onHere = everywhere && !settings.disabledSites.includes(site);

  return (
    <div className="popover shield-popover" role="dialog" aria-label="Shields">
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
      <button className="link" onClick={() => onOpenPanel('privacy')}>
        {totalBlocked.toLocaleString()} blocked in total · Privacy report
      </button>
      {engine?.lastError ? <p className="warn-text">Filters could not be loaded: {engine.lastError}</p> : null}
    </div>
  );
}
