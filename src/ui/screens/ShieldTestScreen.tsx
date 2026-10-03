import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ShieldEngine, ShieldWebView, type EngineStatus, type ShieldWebViewRef } from '../../../native/shield-webview';
import { applyDevProxy } from '../../blocking/devProxy';
import { useSettings } from '../../browser/settings';
import { useTheme } from '../theme';

/** d3ward's original test is archived; the maintained fork runs the same checks. */
const TEST_PAGES = [
  { label: 'Ad block test', url: 'https://adblock.turtlecute.org/' },
  { label: 'd3ward (archived)', url: 'https://d3ward.github.io/toolz/adblock' },
  { label: 'Can you block it', url: 'https://canyoublockit.com/' },
  { label: 'AdBlock Tester', url: 'https://adblock-tester.com/' },
];

type Props = { onClose?: () => void };

export default function ShieldTestScreen({ onClose }: Props) {
  const theme = useTheme();
  const webView = useRef<ShieldWebViewRef>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [blocked, setBlocked] = useState(0);
  const [page, setPage] = useState(TEST_PAGES[0].url);
  const [progress, setProgress] = useState(0);
  const [networkReady, setNetworkReady] = useState(false);

  useEffect(() => {
    applyDevProxy().then(() => setNetworkReady(true));
    ShieldEngine.getStatus().then(setStatus);
    const sub = ShieldEngine.addListener('onEngineChanged', setStatus);
    return () => sub.remove();
  }, []);

  const { settings, update } = useSettings();
  const shieldsOn = settings.shields.enabled;

  const toggleShields = (value: boolean) => {
    update({ shields: { enabled: value } });
    // Settings reach the native engine in an effect; reload after it runs.
    setTimeout(() => webView.current?.reload(), 50);
  };

  const open = (url: string) => {
    setPage(url);
    webView.current?.loadUrl(url);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: theme.text }]}>Shield test</Text>
          <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={2}>
            {status?.ready
              ? `Filters ${status.version} · ${status.source} · loaded in ${status.buildMillis} ms`
              : status?.lastError
                ? `Engine error: ${status.lastError}`
                : 'Loading filters…'}
          </Text>
        </View>
        {onClose ? (
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.close, { color: theme.accent }]}>Done</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[styles.row, { borderColor: theme.border }]}>
        <Text style={[styles.counter, { color: theme.text }]} testID="blocked-count">
          {blocked} blocked on this page
        </Text>
        <Text style={[styles.meta, { color: theme.muted }]}>Shields</Text>
        <Switch value={shieldsOn} onValueChange={toggleShields} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipBar}
        contentContainerStyle={styles.chips}>
        {TEST_PAGES.map((p) => (
          <Pressable
            key={p.url}
            onPress={() => open(p.url)}
            style={[
              styles.chip,
              { borderColor: theme.border, backgroundColor: p.url === page ? theme.accentSoft : 'transparent' },
            ]}>
            <Text style={{ color: theme.text, fontSize: 13 }}>{p.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={[styles.progress, { width: `${progress * 100}%`, backgroundColor: theme.accent }]} />

      {status?.ready && networkReady ? (
        <ShieldWebView
          ref={webView}
          style={styles.web}
          initialUrl={page}
          forceDark={theme.dark}
          onLoadProgress={(e) => setProgress(e.nativeEvent.progress >= 1 ? 0 : e.nativeEvent.progress)}
          onBlockedCountChange={(e) => setBlocked(e.nativeEvent.blocked)}
        />
      ) : (
        <View style={styles.web} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  meta: { fontSize: 12 },
  close: { fontSize: 16, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  counter: { flex: 1, fontSize: 15, fontWeight: '500' },
  chipBar: { flexGrow: 0 },
  chips: { paddingHorizontal: 12, paddingVertical: 8, gap: 8, alignItems: 'center' },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  progress: { height: 2 },
  web: { flex: 1 },
});
