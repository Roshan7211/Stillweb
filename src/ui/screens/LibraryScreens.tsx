import { useEffect, useState } from 'react';
import { Alert, FlatList, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ShieldEngine } from '../../../native/shield-webview';
import { useLibrary } from '../../browser/library';
import { displayUrl } from '../../browser/url';
import { IconButton, Row, ScreenHeader } from '../components/primitives';
import type { Theme } from '../theme';

type Props = { theme: Theme; onBack: () => void; onOpen: (url: string) => void };

function Empty({ theme, text }: { theme: Theme; text: string }) {
  return <Text style={[styles.empty, { color: theme.muted }]}>{text}</Text>;
}

export function BookmarksScreen({ theme, onBack, onOpen }: Props) {
  const { bookmarks, removeBookmark } = useLibrary();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="Bookmarks" onBack={onBack} theme={theme} />
      <FlatList
        data={bookmarks}
        keyExtractor={(b) => b.id}
        ListEmptyComponent={<Empty theme={theme} text="Bookmarks you add from the menu appear here." />}
        renderItem={({ item }) => (
          <Row
            title={item.title}
            subtitle={displayUrl(item.url)}
            icon="star"
            theme={theme}
            onPress={() => onOpen(item.url)}
            right={<IconButton name="trash-2" label="Delete bookmark" color={theme.muted} size={18} onPress={() => removeBookmark(item.id)} />}
          />
        )}
      />
    </SafeAreaView>
  );
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function HistoryScreen({ theme, onBack, onOpen }: Props) {
  const { history, removeHistory, clearHistory } = useLibrary();
  const rows: ({ kind: 'day'; label: string } | { kind: 'item'; url: string; title: string; visitedAt: number })[] = [];
  let lastDay = '';
  for (const h of history) {
    const label = dayLabel(h.visitedAt);
    if (label !== lastDay) {
      rows.push({ kind: 'day', label });
      lastDay = label;
    }
    rows.push({ kind: 'item', ...h });
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader
        title="History"
        onBack={onBack}
        theme={theme}
        right={
          history.length ? (
            <IconButton
              name="trash-2"
              label="Clear history"
              color={theme.text}
              onPress={() =>
                Alert.alert('Clear history?', 'This removes every page from your history.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Clear', style: 'destructive', onPress: clearHistory },
                ])
              }
            />
          ) : null
        }
      />
      <FlatList
        data={rows}
        keyExtractor={(r, i) => (r.kind === 'day' ? `d-${r.label}` : `h-${r.visitedAt}-${i}`)}
        ListEmptyComponent={<Empty theme={theme} text="Pages you visit appear here. Private tabs are never saved." />}
        renderItem={({ item }) =>
          item.kind === 'day' ? (
            <Text style={[styles.day, { color: theme.muted }]}>{item.label}</Text>
          ) : (
            <Row
              title={item.title}
              subtitle={displayUrl(item.url)}
              theme={theme}
              onPress={() => onOpen(item.url)}
              right={<IconButton name="x" label="Remove from history" color={theme.muted} size={18} onPress={() => removeHistory(item.url)} />}
            />
          )
        }
      />
    </SafeAreaView>
  );
}

type Status = { status: string; bytes: number; total: number };

function formatBytes(n: number): string {
  if (n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function DownloadsScreen({ theme, onBack }: Omit<Props, 'onOpen'>) {
  const { downloads, removeDownload } = useLibrary();
  // Live state by download record: Android asks DownloadManager by id, iOS checks the files.
  const [status, setStatus] = useState<Record<string, Status>>({});

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const next: Record<string, Status> = {};
      if (Platform.OS === 'android') {
        const tracked = downloads.filter((d) => d.nativeId !== undefined);
        if (!tracked.length) return;
        const rows = new Map((await ShieldEngine.getDownloads(tracked.map((d) => d.nativeId!))).map((r) => [r.id, r]));
        tracked.forEach((d) => {
          const row = rows.get(d.nativeId!);
          if (row) next[d.id] = row;
        });
      } else {
        const tracked = downloads.filter((d) => d.filePath);
        if (!tracked.length) return;
        const rows = new Map((await ShieldEngine.getFileDownloads(tracked.map((d) => d.filePath!))).map((r) => [r.path, r]));
        tracked.forEach((d) => {
          const row = rows.get(d.filePath!);
          if (row) next[d.id] = row;
        });
      }
      if (alive) setStatus(next);
    };
    poll().catch(() => {});
    const timer = setInterval(() => poll().catch(() => {}), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [downloads]);

  const open = (item: (typeof downloads)[number]) => {
    if (Platform.OS === 'ios' && item.filePath) {
      ShieldEngine.openFile(item.filePath).then((ok) => !ok && Alert.alert('File not found', 'It may have been deleted in the Files app.'));
    } else if (item.nativeId !== undefined) {
      ShieldEngine.openDownload(item.nativeId).then((ok) => !ok && Alert.alert('No app can open this file'));
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="Downloads" onBack={onBack} theme={theme} />
      <FlatList
        data={downloads}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={
          <Empty
            theme={theme}
            text={
              Platform.OS === 'ios'
                ? 'Downloaded files appear here and in Files › Stillweb › Downloads.'
                : 'Downloaded files appear here and in your Downloads folder.'
            }
          />
        }
        renderItem={({ item }) => {
          const s = status[item.id];
          const detail = !s
            ? Platform.OS === 'ios' && item.filePath
              ? 'Checking…'
              : 'No longer available'
            : s.status === 'done'
              ? formatBytes(s.total) || 'Done'
              : s.status === 'failed'
                ? 'Failed'
                : s.status === 'missing'
                  ? 'Deleted'
                  : `${formatBytes(s.bytes)}${s.total > 0 ? ` of ${formatBytes(s.total)}` : ''} · ${s.status === 'running' ? 'downloading' : s.status}`;
          return (
            <Row
              title={item.fileName}
              subtitle={`${detail} · ${displayUrl(item.url).split('/')[0]}`}
              icon={s?.status === 'failed' ? 'alert-circle' : s?.status === 'missing' ? 'file-minus' : 'file'}
              theme={theme}
              onPress={s?.status === 'done' ? () => open(item) : undefined}
              right={<IconButton name="x" label="Remove from list" color={theme.muted} size={18} onPress={() => removeDownload(item.id)} />}
            />
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 60, marginHorizontal: 32, fontSize: 15, lineHeight: 21 },
  day: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
});
