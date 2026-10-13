import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Animated, Easing, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ShieldEngine } from '../../../native/shield-webview';
import { useLibrary } from '../../browser/library';
import { usePrivacyStatsActions } from '../../browser/privacyStats';
import { formatBytes, fraction, nextRate, progressText, type Rate } from '../../browser/downloadProgress';
import { displayUrl } from '../../browser/url';
import { Icon, IconButton, Row, ScreenHeader } from '../components/primitives';
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
  const stats = usePrivacyStatsActions();
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
                Alert.alert('Clear history?', 'This removes every page from your history and the sites in your privacy report.', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: () => {
                      clearHistory();
                      stats.clear();
                    },
                  },
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

/** How often a download in progress is looked at again. */
const POLL_MS = 1000;

let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled()
  .then((value) => {
    reduceMotion = value;
  })
  .catch(() => {});

/**
 * A download's bar. It grows smoothly from one reading to the next (over the time until the
 * next one), so it keeps moving instead of jumping once a second; with no size known, a
 * stripe runs along it instead.
 */
function ProgressBar({ theme, value }: { theme: Theme; value: number | null }) {
  const [width] = useState(() => new Animated.Value(value ?? 0));
  const [sweep] = useState(() => new Animated.Value(0));
  const [track, setTrack] = useState(0);
  useEffect(() => {
    if (value === null) return;
    Animated.timing(width, {
      toValue: value,
      duration: reduceMotion ? 0 : POLL_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
  }, [value, width]);
  useEffect(() => {
    if (value !== null) return;
    // Without animations the stripe stays put, partly along the bar (not off its left end).
    if (reduceMotion) return sweep.setValue(0.4);
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [value, sweep]);
  return (
    <View style={[styles.track, { backgroundColor: theme.surface }]} onLayout={(e) => setTrack(e.nativeEvent.layout.width)}>
      {value === null ? (
        <Animated.View
          style={[
            styles.stripe,
            { backgroundColor: theme.accent, width: track * 0.3 },
            { transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-track * 0.3, track] }) }] },
          ]}
        />
      ) : (
        <Animated.View
          style={[styles.fill, { backgroundColor: theme.accent, width: width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
        />
      )}
    </View>
  );
}

function DownloadRow({
  theme,
  title,
  status,
  rate,
  site,
  checking,
  onOpen,
  onRemove,
}: {
  theme: Theme;
  title: string;
  status: Status | undefined;
  rate: Rate | undefined;
  site: string;
  checking: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const s = status;
  const active = s?.status === 'running' || s?.status === 'pending';
  const value = s ? fraction(s.bytes, s.total) : null;
  const detail = !s
    ? checking
      ? 'Checking…'
      : 'No longer available'
    : active
      ? s.status === 'pending' && !s.bytes
        ? 'Waiting…'
        : progressText(s.bytes, s.total, rate)
      : s.status === 'paused'
        ? `Paused · ${formatBytes(s.bytes) || '0 B'}${s.total > 0 ? ` of ${formatBytes(s.total)}` : ''}`
        : s.status === 'done'
          ? formatBytes(s.total) || 'Done'
          : s.status === 'failed'
            ? 'Failed'
            : 'Deleted';
  const percent = active && value !== null ? `${Math.floor(value * 100)}%` : '';
  return (
    <Pressable
      onPress={s?.status === 'done' ? onOpen : undefined}
      disabled={s?.status !== 'done'}
      accessibilityRole={s?.status === 'done' ? 'button' : undefined}
      accessibilityLabel={`${title}, ${percent ? `${percent}, ` : ''}${detail}`}
      style={({ pressed }) => [styles.download, pressed && { backgroundColor: theme.surface }]}>
      <Icon name={s?.status === 'failed' ? 'alert-circle' : s?.status === 'missing' ? 'file-minus' : active ? 'download' : 'file'} size={20} color={active ? theme.accent : theme.muted} />
      <View style={styles.downloadText}>
        <View style={styles.downloadTitleRow}>
          <Text style={[styles.downloadTitle, { color: theme.text }]} numberOfLines={1}>
            {title}
          </Text>
          {percent ? <Text style={[styles.percent, { color: theme.accent }]}>{percent}</Text> : null}
        </View>
        {active || s?.status === 'paused' ? <ProgressBar theme={theme} value={s?.status === 'paused' ? (value ?? 0) : value} /> : null}
        <Text style={[styles.downloadDetail, { color: theme.muted }]} numberOfLines={1}>
          {active ? detail : `${detail} · ${site}`}
        </Text>
      </View>
      <IconButton name="x" label="Remove from list" color={theme.muted} size={18} onPress={onRemove} />
    </Pressable>
  );
}

export function DownloadsScreen({ theme, onBack }: Omit<Props, 'onOpen'>) {
  const { downloads, removeDownload } = useLibrary();
  // Live state by download record: Android asks DownloadManager by id, iOS checks the files.
  const [status, setStatus] = useState<Record<string, Status>>({});
  // Speed so far by download record (for the time left).
  const [rates, setRates] = useState<Record<string, Rate>>({});

  // Polled again only when the list itself changes (not when history does).
  const downloadsKey = downloads.map((d) => `${d.id}:${d.nativeId ?? d.filePath ?? ''}`).join('|');
  const downloadsRef = useRef(downloads);
  useEffect(() => {
    downloadsRef.current = downloads;
  });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const poll = async () => {
      const downloads = downloadsRef.current;
      const next: Record<string, Status> = {};
      if (Platform.OS === 'android') {
        const tracked = downloads.filter((d) => d.nativeId !== undefined);
        if (!tracked.length) return stop();
        const rows = new Map((await ShieldEngine.getDownloads(tracked.map((d) => d.nativeId!))).map((r) => [r.id, r]));
        tracked.forEach((d) => {
          const row = rows.get(d.nativeId!);
          if (row) next[d.id] = row;
        });
      } else {
        const tracked = downloads.filter((d) => d.filePath);
        if (!tracked.length) return stop();
        const rows = new Map((await ShieldEngine.getFileDownloads(tracked.map((d) => d.filePath!))).map((r) => [r.path, r]));
        tracked.forEach((d) => {
          const row = rows.get(d.filePath!);
          if (row) next[d.id] = row;
        });
      }
      if (!alive) return;
      setStatus(next);
      const now = Date.now();
      setRates((before) => {
        const after: Record<string, Rate> = {};
        for (const [id, s] of Object.entries(next)) {
          if (s.status === 'running' || s.status === 'pending') after[id] = nextRate(before[id], s.bytes, now);
        }
        return after;
      });
      // Nothing downloading any more: stop asking every second.
      const running = Object.values(next).some((s) => s.status === 'running' || s.status === 'pending' || s.status === 'paused');
      if (!running) stop();
    };
    // The timer first, so a first poll that finds nothing to watch can stop it.
    timer = setInterval(() => poll().catch(() => {}), POLL_MS);
    poll().catch(() => {});
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [downloadsKey]);

  const open = (item: (typeof downloads)[number]) => {
    if (Platform.OS === 'ios' && item.filePath) {
      ShieldEngine.openFile(item.filePath)
        .then((ok) => !ok && Alert.alert('File not found', 'It may have been deleted in the Files app.'))
        .catch(() => Alert.alert('Couldn’t open this file'));
    } else if (item.nativeId !== undefined) {
      ShieldEngine.openDownload(item.nativeId)
        .then((ok) => !ok && Alert.alert('No app can open this file'))
        .catch(() => Alert.alert('Couldn’t open this file'));
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
        renderItem={({ item }) => (
          <DownloadRow
            theme={theme}
            title={item.fileName}
            status={status[item.id]}
            rate={rates[item.id]}
            site={displayUrl(item.url).split('/')[0]}
            checking={Platform.OS === 'ios' && !!item.filePath}
            onOpen={() => open(item)}
            onRemove={() => removeDownload(item.id)}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 60, marginHorizontal: 32, fontSize: 15, lineHeight: 21 },
  day: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  download: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, paddingRight: 4, paddingVertical: 12, minHeight: 64 },
  downloadText: { flex: 1, gap: 6 },
  downloadTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  downloadTitle: { flex: 1, fontSize: 16 },
  percent: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  downloadDetail: { fontSize: 13, fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  stripe: { position: 'absolute', top: 0, bottom: 0, borderRadius: 2 },
});
