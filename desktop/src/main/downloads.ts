// Downloads go straight to the Downloads folder and are listed in the Downloads panel.
import { app, shell, type DownloadItem, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { DownloadState } from '../shared/types';
import { BrowserWin } from './browserWindow';

type Entry = { state: DownloadState; item: DownloadItem | null };

const entries: Entry[] = [];
let nextId = 1;
let timer: NodeJS.Timeout | null = null;

/** "report.pdf", then "report (1).pdf", ... : never writes over a file that is already there. */
function freePath(dir: string, filename: string): string {
  const safe = path.basename(filename) || 'download';
  const { name, ext } = path.parse(safe);
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate) || entries.some((e) => e.state.path === candidate && e.state.state === 'progressing'); n++) {
    candidate = path.join(dir, `${name} (${n})${ext}`);
  }
  return candidate;
}

function broadcast(): void {
  timer ??= setTimeout(() => {
    timer = null;
    const list = getDownloads();
    for (const win of BrowserWin.all) win.send('downloads', list);
  }, 200);
}

export function getDownloads(): DownloadState[] {
  return entries.map((entry) => entry.state).reverse();
}

export function attachDownloads(session: Session): void {
  session.on('will-download', (_event, item, contents) => {
    const file = freePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(file);
    const state: DownloadState = {
      id: nextId++,
      url: item.getURL(),
      filename: path.basename(file),
      path: file,
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
      started: Date.now(),
    };
    const entry: Entry = { state, item };
    entries.push(entry);

    item.on('updated', () => {
      state.received = item.getReceivedBytes();
      state.total = item.getTotalBytes();
      broadcast();
    });
    item.once('done', (_e, result) => {
      state.state = result;
      state.received = item.getReceivedBytes();
      entry.item = null;
      broadcast();
    });
    broadcast();

    const found = contents ? BrowserWin.forTab(contents) : null;
    if (found) {
      found.win.downloadStarted(found.tab);
      found.win.send('open-panel', 'downloads');
    }
  });
}

const find = (id: number) => entries.find((entry) => entry.state.id === id);

export function openDownload(id: number): void {
  const entry = find(id);
  if (entry?.state.state === 'completed') void shell.openPath(entry.state.path);
}

export function showDownload(id: number): void {
  const entry = find(id);
  if (entry) shell.showItemInFolder(entry.state.path);
}

export function cancelDownload(id: number): void {
  find(id)?.item?.cancel();
}

/** Removes finished downloads from the list (the files stay). */
export function clearDownloads(): void {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].state.state !== 'progressing') entries.splice(i, 1);
  broadcast();
}
