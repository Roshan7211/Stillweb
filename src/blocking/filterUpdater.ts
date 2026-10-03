import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import { Directory, File, Paths } from 'expo-file-system';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { ShieldEngine } from '../../native/shield-webview';
import { FILTER_MANIFEST_URL, FILTER_UPDATE_INTERVAL_MS, FILTER_UPDATE_TASK } from './config';

const LAST_CHECK_KEY = 'filters.lastCheck';

type ManifestFile = { file: string; sha256: string; bytes: number };
type Manifest = {
  schema: number;
  version: string;
  android: { lists: (ManifestFile & { id: string; trusted: boolean })[]; resources: ManifestFile };
  ios: { rules: (ManifestFile & { count: number })[]; scriptlets: ManifestFile } | null;
};

export type UpdateResult =
  | { status: 'disabled' | 'skipped' }
  | { status: 'up-to-date'; version: string | null }
  | { status: 'updated'; version: string | null };

let inFlight: Promise<UpdateResult> | null = null;

/**
 * Downloads and activates a newer filter bundle when one is published. Checks at most
 * once per FILTER_UPDATE_INTERVAL_MS unless `force` is set. Native code verifies every
 * file's SHA-256 against the manifest before switching engines.
 */
export function checkForFilterUpdate(options: { force?: boolean } = {}): Promise<UpdateResult> {
  inFlight ??= runCheck(options.force ?? false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(force: boolean): Promise<UpdateResult> {
  if (!FILTER_MANIFEST_URL) return { status: 'disabled' };

  const last = Number(await AsyncStorage.getItem(LAST_CHECK_KEY)) || 0;
  if (!force && Date.now() - last < FILTER_UPDATE_INTERVAL_MS) return { status: 'skipped' };
  // Still loading the built-in filters: compare versions on a later check instead.
  const status = await ShieldEngine.getStatus();
  if (!status.ready && !status.lastError) return { status: 'skipped' };

  const response = await fetch(FILTER_MANIFEST_URL, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`Filter manifest request failed (HTTP ${response.status})`);
  const manifest = (await response.json()) as Manifest;
  await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

  const current = await ShieldEngine.getStatus();
  if (current.version && manifest.version <= current.version) {
    return { status: 'up-to-date', version: current.version };
  }

  const files: ManifestFile[] =
    Platform.OS === 'ios'
      ? manifest.ios
        ? [...manifest.ios.rules, manifest.ios.scriptlets]
        : []
      : [...manifest.android.lists, manifest.android.resources];
  if (!files.length) return { status: 'up-to-date', version: current.version };

  const base = FILTER_MANIFEST_URL.slice(0, FILTER_MANIFEST_URL.lastIndexOf('/') + 1);
  const staging = new Directory(Paths.cache, 'filter-staging');
  if (staging.exists) staging.delete();
  staging.create({ intermediates: true });
  try {
    for (const entry of files) {
      const slash = entry.file.lastIndexOf('/');
      if (slash > 0) new Directory(staging, entry.file.slice(0, slash)).create({ intermediates: true, idempotent: true });
      await File.downloadFileAsync(base + entry.file, new File(staging, entry.file), { idempotent: true });
    }
    new File(staging, 'manifest.json').write(JSON.stringify(manifest));
    const version = await ShieldEngine.applyFilterUpdate(staging.uri);
    return { status: 'updated', version };
  } finally {
    if (staging.exists) staging.delete();
  }
}

// Runs roughly daily in the background (WorkManager on Android, BGTaskScheduler on iOS).
// Must be defined at module scope so the headless task can find it.
TaskManager.defineTask(FILTER_UPDATE_TASK, async () => {
  try {
    await checkForFilterUpdate();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerFilterUpdateTask(): Promise<void> {
  if (!FILTER_MANIFEST_URL) return;
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
  if (!(await TaskManager.isTaskRegisteredAsync(FILTER_UPDATE_TASK))) {
    await BackgroundTask.registerTaskAsync(FILTER_UPDATE_TASK, { minimumInterval: 24 * 60 });
  }
}
