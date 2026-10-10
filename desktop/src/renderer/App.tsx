import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { themeFor } from '../shared/theme';
import type { EngineStatus, Panel, Settings, WindowState } from '../shared/types';
import { api } from './api';
import { FindBar } from './FindBar';
import { ErrorPage, NewTabPage } from './pages';
import { PanelSheet } from './panels';
import { ShieldPopover } from './ShieldPopover';
import { TabStrip } from './TabStrip';
import { Toolbar } from './Toolbar';

export function App() {
  const [win, setWin] = useState<WindowState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  /** Counts requests to put the cursor in the address bar. */
  const [focusAddress, setFocusAddress] = useState(0);
  const bars = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.getWindowState().then(setWin);
    void api.getSettings().then(setSettings);
    void api.getEngineStatus().then(setEngine);
    const stop = [
      api.on('window-state', setWin),
      api.on('settings', setSettings),
      api.on('engine-status', setEngine),
      api.on('focus-address', () => setFocusAddress((n) => n + 1)),
      api.on('open-find', () => setFindOpen(true)),
      api.on('open-panel', (name) => {
        setShieldOpen(false);
        setPanel(name);
      }),
    ];
    // Only now can messages from the main process be heard.
    void api.interfaceReady();
    return () => stop.forEach((off) => off());
  }, []);

  const active = win?.tabs.find((tab) => tab.id === win.activeId) ?? null;
  const blank = !active || active.url === '';
  const failed = !!active?.error;
  // The interface needs the whole window whenever it draws below the bars.
  const expanded = blank || failed || panel !== null || shieldOpen || suggesting;

  useLayoutEffect(() => {
    const element = bars.current;
    if (!element) return;
    const report = () => void api.setLayout({ barHeight: element.getBoundingClientRect().height, expanded });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, win === null]);

  const dark = settings?.theme === 'system' || !settings ? !!win?.systemDark : settings.theme === 'dark';
  const theme = themeFor(dark, !!win?.private);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    for (const [name, value] of Object.entries(theme)) {
      if (typeof value === 'string') style.setProperty(`--${name}`, value);
    }
    style.colorScheme = theme.dark ? 'dark' : 'light';
  }, [theme]);

  // A page with a find bar loses it when the tab changes.
  const activeId = win?.activeId;
  useEffect(() => {
    setFindOpen(false);
    setShieldOpen(false);
  }, [activeId]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    void api.stopFind();
    void api.focusPage();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (shieldOpen) setShieldOpen(false);
      else if (panel) setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, shieldOpen]);

  if (!win || !settings) return null;

  return (
    <div className={`app${win.private ? ' private' : ''}`}>
      <div className="bars" ref={bars}>
        <TabStrip win={win} />
        <Toolbar
          tab={active}
          settings={settings}
          isPrivate={win.private}
          focusRequest={focusAddress}
          shieldOpen={shieldOpen}
          onToggleShield={() => setShieldOpen((open) => !open)}
          onSuggesting={setSuggesting}
          onOpenPanel={setPanel}
        />
        {findOpen && active && !blank ? <FindBar key={active.id} onClose={closeFind} /> : null}
      </div>

      {expanded ? (
        <div className="below">
          {blank ? (
            <NewTabPage isPrivate={win.private} totalBlocked={win.totalBlocked} engine={engine} onOpenPanel={setPanel} />
          ) : failed && active?.error ? (
            <ErrorPage error={active.error} settings={settings} />
          ) : null}
          {shieldOpen || panel ? (
            <div
              className={`scrim${panel ? ' dim' : ''}`}
              onMouseDown={() => {
                setShieldOpen(false);
                setPanel(null);
              }}
            />
          ) : null}
          {shieldOpen && active ? (
            <ShieldPopover tab={active} settings={settings} totalBlocked={win.totalBlocked} engine={engine} onClose={() => setShieldOpen(false)} onOpenPanel={setPanel} />
          ) : null}
          {panel ? <PanelSheet panel={panel} settings={settings} engine={engine} isPrivate={win.private} onClose={() => setPanel(null)} /> : null}
        </div>
      ) : null}
    </div>
  );
}
