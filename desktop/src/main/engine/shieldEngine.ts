import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { EngineStatus, ShieldSettings } from '../../shared/types';
import { dataPath, resourcePath, writeFileAtomic } from '../store';
import { AdblockWasm, type CosmeticResources, type Engine, type Verdict } from './wasm';

type ManifestFile = { file: string; sha256: string; bytes: number };
type Manifest = {
  schema: number;
  version: string;
  android: { lists: (ManifestFile & { id: string; trusted: boolean; group?: string })[]; resources: ManifestFile };
  /** The lines that differ on a computer (absent in bundles built before the desktop app). */
  desktop?: { delta: ManifestFile } | null;
};
/** Per list id: lines to drop from, and to add to, the list as it was prepared for phones. */
type Delta = Record<string, { remove: string[]; add: string[] }>;

const COOKIE_LIST_ID = 'easylist-cookie';
/** The id the app's own list goes by in Settings › Filter lists. */
export const FIXES_LIST_ID = 'stillweb-fixes';
const ALLOW: Verdict = { action: 'allow' };

function readOptional(file: string): Uint8Array | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Owner of the adblock-rust engine for the whole app (the desktop counterpart of ShieldEngine.kt).
 *
 * Filter bundles (see scripts/filters/build.mjs) live in two places:
 *   the app's resources      - the offline default (the same lists the Android app ships)
 *   <user data>/shield/active - the most recent verified download
 * Whichever has the newer manifest version is loaded. Compiled engines are cached as
 * <user data>/shield/engine-<key>.dat so later launches skip list parsing.
 */
class ShieldEngine {
  private wasm: AdblockWasm | null = null;
  private engine: Engine | null = null;
  private readonly root = dataPath('shield');

  version: string | null = null;
  source: EngineStatus['source'] = 'none';
  buildMillis = 0;
  lastError: string | null = null;
  /** Bumped when filters or settings change, so cached cosmetics are dropped. */
  generation = 0;

  options: ShieldSettings = {
    enabled: true,
    httpsUpgrade: true,
    blockPopups: true,
    cosmeticFiltering: true,
    blockThirdPartyCookies: true,
    hideCookieBanners: true,
  };
  private disabledSites = new Set<string>();
  private disabledLists = new Set<string>();

  private readonly cosmeticCache = new Map<string, CosmeticResources>();
  private readonly readyWaiters: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  get isReady(): boolean {
    return this.engine !== null;
  }

  /** Runs `action` once filters are loaded, or right away if they are (or failed to load). */
  whenReady(action: () => void): void {
    if (this.isReady || this.lastError) action();
    else this.readyWaiters.push(action);
  }

  onChanged(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const waiter of this.readyWaiters.splice(0)) waiter();
    for (const listener of this.listeners) listener();
  }

  status(): EngineStatus {
    return { ready: this.isReady, version: this.version, source: this.source, buildMillis: this.buildMillis, lastError: this.lastError };
  }

  // ---------------------------------------------------------------------------
  // Queries

  check(url: string, sourceUrl: string, requestType: string): Verdict {
    if (!this.engine || !this.wasm) return ALLOW;
    try {
      return this.wasm.check(this.engine, url, sourceUrl, requestType);
    } catch {
      return ALLOW;
    }
  }

  /** Hide rules and scriptlets for a host; cached until the filters or settings change. */
  cosmeticResources(host: string): CosmeticResources | null {
    if (!this.engine || !this.wasm) return null;
    const cached = this.cosmeticCache.get(host);
    if (cached) return cached;
    try {
      const resources = this.wasm.cosmeticResources(this.engine, `https://${host}/`);
      if (this.cosmeticCache.size >= 300) this.cosmeticCache.clear();
      this.cosmeticCache.set(host, resources);
      return resources;
    } catch {
      return null;
    }
  }

  hiddenSelectors(classes: string[], ids: string[], exceptions: string[]): string {
    if (!this.engine || !this.wasm) return '[]';
    try {
      return this.wasm.hiddenSelectors(this.engine, JSON.stringify({ classes, ids, exceptions }));
    } catch {
      return '[]';
    }
  }

  isThirdParty(url: string, sourceUrl: string): boolean {
    try {
      return this.wasm?.isThirdParty(url, sourceUrl) ?? false;
    } catch {
      return false;
    }
  }

  /** False when shields are off, or off for this host or a parent site. */
  shieldsEnabledFor(host: string | null | undefined): boolean {
    if (!this.options.enabled) return false;
    if (!host) return true;
    let h = host.toLowerCase();
    for (;;) {
      if (this.disabledSites.has(h)) return false;
      const dot = h.indexOf('.');
      if (dot < 0) return true;
      h = h.slice(dot + 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings

  /** Applies the user's settings. The engine is rebuilt when the set of lists changes. */
  configure(options: ShieldSettings, disabledSites: string[], disabledLists: string[]): void {
    const listsBefore = this.listKey();
    this.options = { ...options };
    this.disabledSites = new Set(disabledSites.map((s) => s.toLowerCase()));
    this.disabledLists = new Set(disabledLists);
    this.generation++;
    if (this.wasm && this.listKey() !== listsBefore) this.load();
  }

  private listKey(): string {
    return `${this.options.hideCookieBanners}|${[...this.disabledLists].sort().join(',')}`;
  }

  // ---------------------------------------------------------------------------
  // Loading

  /** Loads the engine and the best filter bundle. Call once, after the first window is up. */
  initialize(): void {
    try {
      this.wasm = new AdblockWasm(fs.readFileSync(resourcePath('engine.wasm', 'resources/engine.wasm')));
      fs.mkdirSync(this.root, { recursive: true });
    } catch (error) {
      this.fail(error);
      return;
    }
    this.load();
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    console.error('[shield] engine load failed:', error);
    this.notify();
  }

  private load(): void {
    try {
      this.loadBest();
    } catch (error) {
      this.fail(error);
    }
  }

  /** The filter bundle that ships with the app. */
  bundledDir(): string {
    return resourcePath('shield', '../native/shield-webview/android/src/main/assets/shield');
  }

  private readManifest(dir: string): Manifest {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  }

  private loadBest(): void {
    const bundled = this.bundledDir();
    const active = path.join(this.root, 'active');
    const bundledVersion = this.readManifest(bundled).version;
    let activeVersion: string | null = null;
    try {
      activeVersion = this.readManifest(active).version;
    } catch {
      // No download yet.
    }
    // ISO-8601 UTC timestamps compare correctly as strings.
    if (activeVersion && activeVersion > bundledVersion) {
      try {
        this.buildFrom(active, 'downloaded');
        return;
      } catch (error) {
        console.warn('[shield] downloaded filters failed to load, falling back to bundled', error);
      }
    }
    this.buildFrom(bundled, 'bundled');
  }

  /** The lines that differ on a computer: from the bundle if it has them, else the app's copy. */
  private readDelta(dir: string, manifest: Manifest, sourceName: string): string | null {
    try {
      if (manifest.desktop?.delta) return fs.readFileSync(path.join(dir, manifest.desktop.delta.file), 'utf8');
      if (sourceName === 'bundled') return fs.readFileSync(resourcePath('shield-delta.json', 'resources/shield-delta.json'), 'utf8');
    } catch {
      // Without them the lists are used as prepared for phones.
    }
    return null;
  }

  private buildFrom(dir: string, sourceName: 'bundled' | 'downloaded'): void {
    const wasm = this.wasm;
    if (!wasm) throw new Error('engine not loaded');
    const started = performance.now();
    const manifest = this.readManifest(dir);
    const deltaText = this.readDelta(dir, manifest, sourceName);

    const lists = manifest.android.lists.filter((entry) => {
      // Calm Mode's annoyance lists are not part of the desktop app.
      if (entry.group === 'calm') return false;
      // The phones' copy of the app's own fixes: the desktop app reads its own (below).
      if (entry.id === FIXES_LIST_ID) return false;
      if (entry.id === COOKIE_LIST_ID && !this.options.hideCookieBanners) return false;
      return !this.disabledLists.has(entry.id);
    });
    const ids = lists.map((l) => l.id).sort().join(',');
    // The app's own rules for sites the shared lists do not cover (resources/stillweb-fixes.txt).
    const fixes = this.disabledLists.has(FIXES_LIST_ID) ? null : readOptional(resourcePath('stillweb-fixes.txt', 'resources/stillweb-fixes.txt'));
    const key = sha256(`${manifest.version}|${sourceName}|${ids}|${deltaText ? sha256(deltaText) : ''}|${fixes ? sha256(fixes) : ''}`).slice(0, 16);
    const cache = path.join(this.root, `engine-${key}.dat`);

    let engine: Engine | null = null;
    if (fs.existsSync(cache)) {
      engine = wasm.deserialize(fs.readFileSync(cache));
      if (!engine) fs.rmSync(cache, { force: true });
    }
    if (!engine) {
      const delta = deltaText ? (JSON.parse(deltaText) as Delta) : {};
      const sources = lists.map((entry) => ({
        text: applyDelta(fs.readFileSync(path.join(dir, entry.file)), delta[entry.id]),
        trusted: entry.trusted,
      }));
      if (fixes) sources.push({ text: fixes, trusted: true });
      engine = wasm.build(sources);
      for (const name of fs.readdirSync(this.root)) {
        if (name.startsWith('engine-') && name.endsWith('.dat')) fs.rmSync(path.join(this.root, name), { force: true });
      }
      writeFileAtomic(cache, wasm.serialize(engine));
    }
    const resourceCount = wasm.useResources(engine, fs.readFileSync(path.join(dir, manifest.android.resources.file)));
    if (resourceCount < 0) console.warn('[shield] could not load scriptlets and redirect resources');

    // The first check of each kind is slow (the engine prepares itself on first use): do
    // those now, so the first page does not pay for them.
    for (const kind of ['script', 'image', 'stylesheet', 'xmlhttprequest', 'sub_frame', 'document', 'other']) {
      wasm.check(engine, `https://warm-up.invalid/a/b.js?c=${kind}`, 'https://www.example.com/', kind);
    }

    const old = this.engine;
    this.engine = engine;
    if (old) wasm.free(old);
    this.cosmeticCache.clear();
    this.version = manifest.version;
    this.source = sourceName;
    this.lastError = null;
    this.buildMillis = Math.round(performance.now() - started);
    this.generation++;
    console.log(`[shield] loaded ${sourceName} filters ${manifest.version} (${lists.length} lists, ${resourceCount} resources) in ${this.buildMillis}ms`);
    this.notify();
  }

  /**
   * Verifies a downloaded bundle in `staging` (manifest.json and the files it lists), makes it
   * the active bundle and rebuilds the engine. Returns the version now in use.
   */
  applyUpdate(staging: string): string | null {
    const manifest = this.readManifest(staging);
    const files: ManifestFile[] = [...manifest.android.lists, manifest.android.resources];
    if (manifest.desktop?.delta) files.push(manifest.desktop.delta);
    for (const entry of files) {
      const file = path.resolve(staging, entry.file);
      if (!file.startsWith(path.resolve(staging) + path.sep)) throw new Error(`bad path ${entry.file}`);
      if (!fs.existsSync(file)) throw new Error(`missing ${entry.file}`);
      if (sha256(fs.readFileSync(file)) !== entry.sha256) throw new Error(`checksum mismatch for ${entry.file}`);
    }
    const active = path.join(this.root, 'active');
    const incoming = path.join(this.root, 'active.incoming');
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.cpSync(staging, incoming, { recursive: true });
    fs.rmSync(active, { recursive: true, force: true });
    fs.renameSync(incoming, active);
    this.loadBest();
    return this.version;
  }
}

/** Drops and adds whole lines; a list without differences is passed through untouched. */
function applyDelta(bytes: Uint8Array, delta: Delta[string] | undefined): Uint8Array {
  if (!delta || (!delta.remove.length && !delta.add.length)) return bytes;
  const remove = new Set(delta.remove);
  const lines = new TextDecoder().decode(bytes).split('\n').filter((line) => !remove.has(line));
  return new TextEncoder().encode(lines.concat(delta.add).join('\n') + '\n');
}

export const shieldEngine = new ShieldEngine();
