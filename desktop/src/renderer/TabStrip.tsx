import { Globe, Plus, Volume2, VolumeX, X } from 'lucide-react';
import { memo, useState } from 'react';

import { displayHost } from '../../../src/browser/url';
import type { TabState, WindowState } from '../shared/types';
import { api } from './api';

type TabProps = { tab: TabState; active: boolean; index: number; dragged: number | null; onDrag: (id: number | null) => void };

const TabItem = memo(function TabItem({ tab, active, index, dragged, onDrag }: TabProps) {
  const [iconFailed, setIconFailed] = useState<string | null>(null);
  const title = tab.title || displayHost(tab.url) || 'New Tab';
  const showIcon = tab.favicon && iconFailed !== tab.favicon;
  return (
    <div
      className={`tab${active ? ' active' : ''}${dragged === tab.id ? ' dragging' : ''}`}
      role="tab"
      aria-selected={active}
      title={title}
      draggable
      onMouseDown={(event) => {
        if (event.button === 0) void api.activateTab(tab.id);
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
        if (dragged !== null && dragged !== tab.id) void api.moveTab(dragged, index);
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
});

export function TabStrip({ win }: { win: WindowState }) {
  const [dragged, setDragged] = useState<number | null>(null);
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
      {win.tabs.map((tab, index) => (
        <TabItem key={tab.id} tab={tab} active={tab.id === win.activeId} index={index} dragged={dragged} onDrag={setDragged} />
      ))}
      <button className="icon-button new-tab" aria-label="New tab" title="New tab" onClick={() => void api.newTab()}>
        <Plus size={16} />
      </button>
    </div>
  );
}
