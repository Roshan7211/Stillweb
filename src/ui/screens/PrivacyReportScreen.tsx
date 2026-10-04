import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { dayKey, lastDays, topEntries, usePrivacyStats } from '../../browser/privacyStats';
import { usePlus } from '../../plus/plus';
import { Icon, ScreenHeader, SectionTitle } from '../components/primitives';
import type { Theme } from '../theme';

type Props = { theme: Theme; onBack: () => void; onUpgrade: () => void };

type Range = 'week' | 'month' | 'year';
const RANGES: { id: Range; label: string; days: number; plus: boolean }[] = [
  { id: 'week', label: '7 days', days: 7, plus: false },
  { id: 'month', label: '30 days', days: 30, plus: true },
  { id: 'year', label: '12 months', days: 365, plus: true },
];

type Bar = { label: string; detail: string; value: number };

const CHART_HEIGHT = 140;
const number = (n: number) => n.toLocaleString();

export default function PrivacyReportScreen({ theme, onBack, onUpgrade }: Props) {
  const plus = usePlus();
  const days = usePrivacyStats();
  const [range, setRange] = useState<Range>('week');
  const [selected, setSelected] = useState<number | null>(null);
  const spec = RANGES.find((r) => r.id === range)!;
  const rangeLocked = spec.plus && !plus.unlocked;

  const { bars, total, keys } = useMemo(() => {
    const list = lastDays(days, spec.days);
    const keys = list.map((d) => d.key);
    const total = list.reduce((sum, d) => sum + d.blocked, 0);
    let bars: Bar[];
    if (range === 'year') {
      // One bar per month.
      const months: Bar[] = [];
      const today = new Date();
      for (let i = 11; i >= 0; i--) {
        const month = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const prefix = dayKey(month).slice(0, 7);
        const value = list.filter((d) => d.key.startsWith(prefix)).reduce((sum, d) => sum + d.blocked, 0);
        months.push({
          label: month.toLocaleDateString(undefined, { month: 'narrow' }),
          detail: month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
          value,
        });
      }
      bars = months;
    } else {
      bars = list.map((d) => ({
        label: range === 'week' ? d.date.toLocaleDateString(undefined, { weekday: 'narrow' }) : String(d.date.getDate()),
        detail: d.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
        value: d.blocked,
      }));
    }
    return { bars, total, keys };
  }, [days, range, spec.days]);

  const today = days[dayKey(new Date())]?.blocked ?? 0;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const topSites = useMemo(() => topEntries(days, keys, 'sites', 5), [days, keys]);
  const topDomains = useMemo(() => topEntries(days, keys, 'domains', 5), [days, keys]);
  const hasAny = Object.keys(days).length > 0;
  const shown = selected !== null && selected < bars.length ? bars[selected] : null;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="Privacy report" onBack={onBack} theme={theme} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.segment}>
          {RANGES.map((r) => {
            const active = r.id === range;
            return (
              <Pressable
                key={r.id}
                onPress={() => {
                  setRange(r.id);
                  setSelected(null);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.segmentItem, { backgroundColor: active ? theme.accent : theme.surface }]}>
                {r.plus && !plus.unlocked ? <Icon name="lock" size={12} color={active ? '#FFFFFF' : theme.muted} /> : null}
                <Text style={[styles.segmentText, { color: active ? '#FFFFFF' : theme.text }]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {rangeLocked ? (
          <UpgradeCard
            theme={theme}
            title="See your whole year"
            body="Stillweb Plus keeps a year of your privacy history, with the sites you're protected on most and the trackers blocked most."
            onUpgrade={onUpgrade}
          />
        ) : (
          <>
            {/* Hero number for the range, with today beside it. */}
            <View style={styles.hero}>
              <Text style={[styles.heroValue, { color: theme.text }]}>{number(total)}</Text>
              <Text style={[styles.heroLabel, { color: theme.muted }]}>
                ads and trackers blocked in the last {range === 'year' ? '12 months' : spec.label}
              </Text>
              <Text style={[styles.today, { color: theme.muted }]}>Today: {number(today)}</Text>
            </View>

            <View style={styles.chart}>
              {/* Tapped bar's value; the bars carry the same in their accessibility labels. */}
              <Text style={[styles.readout, { color: theme.text }]} numberOfLines={1}>
                {shown ? `${shown.detail}: ${number(shown.value)} blocked` : 'Tap a bar for details'}
              </Text>
              <View style={styles.plot}>
                {bars.map((bar, i) => (
                  <Pressable
                    key={i}
                    style={styles.barSlot}
                    onPress={() => setSelected(i === selected ? null : i)}
                    accessibilityRole="button"
                    accessibilityLabel={`${bar.detail}: ${number(bar.value)} blocked`}>
                    <View
                      style={[
                        styles.bar,
                        {
                          height: bar.value > 0 ? Math.max(3, (bar.value / max) * CHART_HEIGHT) : 0,
                          backgroundColor: theme.chart,
                          opacity: selected === null || selected === i ? 1 : 0.35,
                        },
                      ]}
                    />
                  </Pressable>
                ))}
              </View>
              <View style={[styles.baseline, { backgroundColor: theme.border }]} />
              <View style={styles.labels}>
                {bars.map((bar, i) => (
                  <Text key={i} style={[styles.axisLabel, { color: theme.muted }]} numberOfLines={1}>
                    {range !== 'month' || i % 5 === 0 || i === bars.length - 1 ? bar.label : ''}
                  </Text>
                ))}
              </View>
            </View>

            {!hasAny ? (
              <Text style={[styles.empty, { color: theme.muted }]}>Nothing blocked yet. Browse a little and come back.</Text>
            ) : plus.unlocked ? (
              <>
                <RankedList theme={theme} title="Sites with the most blocking" rows={topSites} />
                <RankedList theme={theme} title="Most blocked domains" rows={topDomains} />
              </>
            ) : (
              <UpgradeCard
                theme={theme}
                title="Where you're tracked most"
                body="See the sites you're protected on most and the trackers blocked most often, with a year of history."
                onUpgrade={onUpgrade}
              />
            )}
          </>
        )}

        <Text style={[styles.note, { color: theme.muted }]}>
          {Platform.OS === 'ios'
            ? 'Counts are estimates on iPhone and iPad: iOS doesn’t tell apps about each blocked request. '
            : ''}
          Private tabs add to the totals only; their sites and domains are never recorded. Clearing browsing data
          clears this report.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function RankedList({ theme, title, rows }: { theme: Theme; title: string; rows: [string, number][] }) {
  if (!rows.length) return null;
  const top = rows[0][1];
  return (
    <View>
      <SectionTitle theme={theme}>{title}</SectionTitle>
      {rows.map(([name, count]) => (
        <View key={name} style={styles.rankRow} accessible accessibilityLabel={`${name}: ${number(count)} blocked`}>
          <View style={styles.rankText}>
            <Text style={[styles.rankName, { color: theme.text }]} numberOfLines={1}>
              {name}
            </Text>
            <View style={[styles.rankTrack, { backgroundColor: theme.surface }]}>
              <View style={[styles.rankFill, { width: `${(count / top) * 100}%`, backgroundColor: theme.chart }]} />
            </View>
          </View>
          <Text style={[styles.rankCount, { color: theme.muted }]}>{number(count)}</Text>
        </View>
      ))}
    </View>
  );
}

function UpgradeCard({ theme, title, body, onUpgrade }: { theme: Theme; title: string; body: string; onUpgrade: () => void }) {
  return (
    <View style={[styles.upgrade, { backgroundColor: theme.surface }]}>
      <Icon name="lock" size={22} color={theme.accent} />
      <Text style={[styles.upgradeTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.upgradeBody, { color: theme.muted }]}>{body}</Text>
      <Pressable style={[styles.upgradeButton, { backgroundColor: theme.accent }]} onPress={onUpgrade} accessibilityRole="button">
        <Text style={styles.upgradeButtonText}>See Stillweb Plus</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  segment: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 16 },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: 10,
  },
  segmentText: { fontWeight: '600' },
  hero: { paddingHorizontal: 20, paddingTop: 24, gap: 2 },
  heroValue: { fontSize: 44, fontWeight: '700' },
  heroLabel: { fontSize: 15 },
  today: { fontSize: 13, marginTop: 6 },
  chart: { paddingHorizontal: 16, paddingTop: 20 },
  readout: { fontSize: 14, fontWeight: '500', marginBottom: 10, paddingHorizontal: 4 },
  plot: { height: CHART_HEIGHT, flexDirection: 'row', alignItems: 'flex-end' },
  // 2px of background between bars.
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end', paddingHorizontal: 1 },
  bar: { borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  baseline: { height: StyleSheet.hairlineWidth },
  labels: { flexDirection: 'row', marginTop: 6 },
  axisLabel: { flex: 1, fontSize: 11, textAlign: 'center' },
  empty: { textAlign: 'center', marginTop: 32, marginHorizontal: 32, fontSize: 15, lineHeight: 21 },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  rankText: { flex: 1, gap: 6 },
  rankName: { fontSize: 15 },
  rankTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  rankFill: { height: 4, borderRadius: 2 },
  rankCount: { fontSize: 14, minWidth: 48, textAlign: 'right' },
  upgrade: { margin: 16, marginTop: 24, padding: 20, borderRadius: 18, alignItems: 'center', gap: 8 },
  upgradeTitle: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  upgradeBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  upgradeButton: { marginTop: 6, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
  upgradeButtonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  note: { fontSize: 12, lineHeight: 17, paddingHorizontal: 20, paddingTop: 24 },
});
