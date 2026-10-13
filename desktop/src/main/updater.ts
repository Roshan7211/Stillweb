// Filter updates: the same bundle the mobile apps download (src/blocking/filterUpdater.ts).
import { net } from 'electron';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { shieldEngine } from './engine/shieldEngine';
import { dataPath, jsonFile, type JsonFile } from './store';

/** The manifest.json published by the Filters workflow; empty when the build did not set it. */
const MANIFEST_URL = process.env.STILLWEB_FILTER_MANIFEST_URL || '';
const INTERVAL_MS = 24 * 60 * 60 * 1000;

type ManifestFile = { file: string; sha256: string; bytes: number };
type Manifest = {
  version: string;
  android: { lists: ManifestFile[]; resources: ManifestFile };
  desktop?: { delta: ManifestFile } | null;
};

let stateFile: JsonFile<{ lastCheck: number }> | null = null;
let inFlight: Promise<string> | null = null;

/**
 * Downloads and activates a newer filter bundle when one is published; at most once a day
 * unless `force` is set. Every file's SHA-256 is verified before the engine switches.
 * Resolves with a sentence for the Settings screen.
 */
export function checkForFilterUpdate(force = false): Promise<string> {
  inFlight ??= runCheck(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(force: boolean): Promise<string> {
  if (!MANIFEST_URL) return 'This build uses the filters it came with.';
  stateFile ??= jsonFile('filter-update.json', { lastCheck: 0 });
  if (!force && Date.now() - stateFile.value.lastCheck < INTERVAL_MS) return 'Checked recently.';
  // Still loading the built-in filters: compare versions on a later check instead.
  if (!shieldEngine.isReady) return 'Filters are still loading.';

  const response = await net.fetch(MANIFEST_URL, { credentials: 'omit', cache: 'no-cache' });
  if (!response.ok) throw new Error(`Filter manifest request failed (HTTP ${response.status})`);
  const manifest = (await response.json()) as Manifest;
  stateFile.value = { lastCheck: Date.now() };
  stateFile.changed();
  if (shieldEngine.version && manifest.version <= shieldEngine.version) return 'Filters are up to date.';

  const files = [...manifest.android.lists, manifest.android.resources];
  if (manifest.desktop?.delta) files.push(manifest.desktop.delta);
  const base = MANIFEST_URL.slice(0, MANIFEST_URL.lastIndexOf('/') + 1);
  const staging = dataPath('shield', 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const entry of files) {
      const target = path.resolve(staging, entry.file);
      if (!target.startsWith(path.resolve(staging) + path.sep)) throw new Error(`bad path ${entry.file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const part = await net.fetch(base + entry.file, { credentials: 'omit' });
      if (!part.ok || !part.body) throw new Error(`Download of ${entry.file} failed (HTTP ${part.status})`);
      await pipeline(Readable.fromWeb(part.body as import('node:stream/web').ReadableStream), createWriteStream(target));
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
    shieldEngine.applyUpdate(staging);
    return 'Filters updated.';
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Checks shortly after startup and then every few hours while the app stays open. */
export function scheduleFilterUpdates(): void {
  if (!MANIFEST_URL) return;
  const check = () => void checkForFilterUpdate().catch((error) => console.warn('[shield] filter update failed:', error));
  setTimeout(check, 30_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
