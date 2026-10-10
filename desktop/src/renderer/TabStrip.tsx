import { Globe, Plus, Volume2, VolumeX, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { displayHost } from '../../../src/browser/url';
import type { TabState, WindowState } from '../shared/types';
import { api } from './api';

type TabProps = {
  tab: TabState;
  active: boolean;
  index: number;
  dragged: number | null;
  /** 'new' slides in, 'leaving' slides out (the tab is already closed), 'still' was there from the start. */
  phase: 'new' | 'leaving' | 'still';
  onDrag: (id: number | null) => void;
};

/** What a tab shows. The state arrives several times a second while pages load; most tabs have not changed. */
function sameTab(a: TabProps, b: TabProps): boolean {
  return (
    a.active === b.active &&
    a.index === b.index &&
    a.phase === b.phase &&
    a.dragged === b.dragged &&
    a.tab.id === b.tab.id &&
    a.tab.title === b.tab.title &&
    a.tab.url === b.tab.url &&
    a.tab.favicon === b.tab.favicon &&
    a.tab.loading === b.tab.loading &&
    a.tab.audible === b.tab.audible &&
    a.tab.muted === b.tab.muted
  );
}

const TabItem = memo(function TabItem({ tab, active, index, dragged, phase, onDrag }: TabProps) {
  const [iconFailed, setIconFailed] = useState<string | null>(null);
  const title = tab.title || displayHost(tab.url) || 'New Tab';
  const showIcon = tab.favicon && iconFailed !== tab.favicon;
  return (
    <div
      className={`tab${active ? ' active' : ''}${dragged === tab.id ? ' dragging' : ''}${phase === 'new' ? ' entering' : phase === 'leaving' ? ' leaving' : ''}`}
      role="tab"
      aria-selected={active}
      title={title}
      draggable
      onMouseDown={(event) => {
        if (event.button === 0 && phase !== 'leaving') void api.activateTab(tab.id);
      }}
      onAuxClick={(event) => {
        // The middle button closes a tab.
        if (event.button === 1) void api.closeTab(tab.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void api.showTabMenu(tab.id, event.clientX, event.clientY);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        onDrag(tab.id);
      }}
      onDragEnd={() => onDrag(null)}
      onDragOver={(event) => {
        if (dragged !== null && dragged !== tab.id) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragged !== null && dragged !== tab.id && index >= 0) void api.moveTab(dragged, index);
        onDrag(null);
      }}>
      <span className="tab-icon">
        {tab.loading ? (
          <span className="spinner" aria-label="Loading" />
        ) : showIcon ? (
          <img src={tab.favicon!} alt="" draggable={false} onError={() => setIconFailed(tab.favicon)} />
        ) : (
          <Globe size={14} />
        )}
      </span>
      <span className="tab-title">{title}</span>
      {tab.audible || tab.muted ? (
        <button
          className="tab-button"
          aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void api.toggleMute(tab.id)}>
          {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      ) : null}
      <button
        className="tab-button tab-close"
        aria-label="Close tab"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => void api.closeTab(tab.id)}>
        <X size={13} />
      </button>
    </div>
  );
}, sameTab);

const EXIT_MS = 140;

/**
 * The tabs to draw: the open ones, plus tabs that were just closed, kept in place for a
 * moment so they can slide shut instead of vanishing.
 */
function useTabsWithExit(tabs: TabState[]): { tab: TabState; phase: TabProps['phase'] }[] {
  const initial = useRef<Set<number> | null>(null);
  initial.current ??= new Set(tabs.map((tab) => tab.id));
  const previous = useRef<TabState[]>(tabs);
  const [ghosts, setGhosts] = useState<{ tab: TabState; after: number | null }[]>([]);

  useEffect(() => {
    const open = new Set(tabs.map((tab) => tab.id));
    const gone = previous.current.filter((tab) => !open.has(tab.id));
    if (gone.length) {
      const before = previous.current;
      const added = gone.map((tab) => {
        // Where it was: after the nearest tab to its left that is still open.
        const index = before.findIndex((t) => t.id === tab.id);
        let after: number | null = null;
        for (let i = index - 1; i >= 0; i--) {
          if (open.has(before[i].id)) {
            after = before[i].id;
            break;
          }
        }
        return { tab, after };
      });
      setGhosts((current) => [...current, ...added]);
      const ids = new Set(gone.map((tab) => tab.id));
      window.setTimeout(() => setGhosts((current) => current.filter((ghost) => !ids.has(ghost.tab.id))), EXIT_MS);
    }
    previous.current = tabs;
  }, [tabs]);

  const out: { tab: TabState; phase: TabProps['phase'] }[] = [];
  const place = (after: number | null) => {
    for (const ghost of ghosts) if (ghost.after === after) out.push({ tab: ghost.tab, phase: 'leaving' });
  };
  place(null);
  for (const tab of tabs) {
    out.push({ tab, phase: initial.current.has(tab.id) ? 'still' : 'new' });
    place(tab.id);
  }
  return out;
}

export function TabStrip({ win }: { win: WindowState }) {
  const [dragged, setDragged] = useState<number | null>(null);
  const shown = useTabsWithExit(win.tabs);
  return (
    <div
      className={`tabstrip buttons-${win.windowButtons}`}
      role="tablist"
      // The empty part of the strip is the window's title bar. The system normally handles
      // presses there itself (see -webkit-app-region in styles.css); these only run if it does not.
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        void api.dragWindow(true);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) void api.dragWindow(false);
      }}
      onPointerCancel={() => void api.dragWindow(false)}
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) void api.toggleMaximize();
      }}>
      {shown.map(({ tab, phase }) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={phase !== 'leaving' && tab.id === win.activeId}
          // The position among the open tabs (a tab that is sliding shut has none).
          index={win.tabs.findIndex((t) => t.id === tab.id)}
          dragged={dragged}
          phase={phase}
          onDrag={setDragged}
        />
      ))}
      <button className="icon-button new-tab" aria-label="New tab" title="New tab" onClick={() => void api.newTab()}>
        <Plus size={16} />
      </button>
    </div>
  );
}
