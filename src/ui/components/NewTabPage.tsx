import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ShieldEngine } from '../../../native/shield-webview';
import { useLibrary } from '../../browser/library';
import { displayUrl, hostOf } from '../../browser/url';
import type { Theme } from '../theme';
import { Icon } from './primitives';

type Props = {
  theme: Theme;
  incognito: boolean;
  totalBlocked: number;
  /** The tab on screen: only one scroll view may answer the iOS status bar tap. */
  active: boolean;
  onOpen: (url: string) => void;
  onOpenReport: () => void;
};

export default function NewTabPage({ theme, incognito, totalBlocked, active, onOpen, onOpenReport }: Props) {
  const { bookmarks } = useLibrary();
  const bg = incognito ? theme.privateBackground : theme.background;
  const fg = incognito ? '#ECE6F7' : theme.text;
  const muted = incognito ? '#B3A8CC' : theme.muted;
  const card = incognito ? theme.privateSurface : theme.surface;

  return (
    <ScrollView
      style={{ backgroundColor: bg }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      scrollsToTop={active}>
      {incognito ? (
        <View style={[styles.card, { backgroundColor: card }]}>
          <Icon name="eye-off" size={26} color={fg} />
          <Text style={[styles.cardTitle, { color: fg }]}>Private tab</Text>
          <Text style={[styles.cardBody, { color: muted }]}>
            Pages you visit here aren't saved to history, and their cookies and site data are deleted when you close
            all private tabs.
            {ShieldEngine.privateTabsIsolated
              ? ' Private tabs keep their own cookies, separate from normal tabs.'
              : ' On this device, private and normal tabs share cookies while both are open.'}
          </Text>
        </View>
      ) : null}

      <Pressable
        style={({ pressed }) => [styles.card, { backgroundColor: card, opacity: pressed ? 0.8 : 1 }]}
        onPress={onOpenReport}
        accessibilityRole="button"
        accessibilityLabel={`${totalBlocked.toLocaleString()} ads and trackers blocked. Open privacy report`}>
        <Icon name="shield" size={26} color={theme.accent} />
        <Text style={[styles.stat, { color: fg }]}>{totalBlocked.toLocaleString()}</Text>
        <Text style={[styles.cardBody, { color: muted }]}>ads and trackers blocked</Text>
        <Text style={[styles.cardLink, { color: theme.accent }]}>Privacy report</Text>
      </Pressable>

      {bookmarks.length > 0 ? (
        <View style={styles.grid}>
          {bookmarks.slice(0, 8).map((b) => (
            <Pressable key={b.id} style={styles.tile} onPress={() => onOpen(b.url)} accessibilityLabel={b.title}>
              <View style={[styles.tileIcon, { backgroundColor: card }]}>
                <Text style={[styles.tileLetter, { color: theme.accent }]}>
                  {(hostOf(b.url).replace(/^www\./, '')[0] ?? '?').toUpperCase()}
                </Text>
              </View>
              <Text style={[styles.tileLabel, { color: muted }]} numberOfLines={1}>
                {b.title || displayUrl(b.url)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingTop: 24 },
  card: { borderRadius: 18, padding: 18, alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: 18, fontWeight: '600' },
  cardBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  stat: { fontSize: 34, fontWeight: '700' },
  cardLink: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  tile: { width: '25%', alignItems: 'center', paddingVertical: 10, gap: 6 },
  tileIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  tileLetter: { fontSize: 22, fontWeight: '700' },
  tileLabel: { fontSize: 12, maxWidth: 76 },
});
