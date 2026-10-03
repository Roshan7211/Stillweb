import { StyleSheet, Switch, Text, View } from 'react-native';

import { useSettings } from '../../browser/settings';
import { siteKey } from '../../browser/url';
import type { Theme } from '../theme';
import { Icon, Row, Sheet } from './primitives';

type Props = {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  url: string;
  blocked: number;
  totalBlocked: number;
  /** Reload so the new shield state takes effect. */
  onChanged: () => void;
  onOpenSettings: () => void;
};

export default function ShieldPanel({ visible, onClose, theme, url, blocked, totalBlocked, onChanged, onOpenSettings }: Props) {
  const { settings, setSiteShields } = useSettings();
  const site = siteKey(url);
  const globallyOn = settings.shields.enabled;
  const siteOn = globallyOn && !settings.disabledSites.includes(site);

  return (
    <Sheet visible={visible} onClose={onClose} theme={theme}>
      <View style={styles.head}>
        <Icon name={siteOn ? 'shield' : 'shield-off'} size={30} color={siteOn ? theme.accent : theme.muted} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.site, { color: theme.text }]} numberOfLines={1}>
            {site || 'New tab'}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 13 }}>
            {!globallyOn ? 'Protection is off everywhere' : siteOn ? 'Blocking ads and trackers' : 'Protection is off for this site'}
          </Text>
        </View>
        {site ? (
          <Switch
            value={siteOn}
            disabled={!globallyOn}
            onValueChange={(on) => {
              setSiteShields(site, on);
              onChanged();
            }}
            trackColor={{ true: theme.accent, false: theme.border }}
            thumbColor="#FFFFFF"
            accessibilityLabel="Protection for this site"
          />
        ) : null}
      </View>

      <View style={styles.stats}>
        <View style={[styles.stat, { backgroundColor: theme.background }]}>
          <Text style={[styles.statValue, { color: theme.text }]}>{blocked}</Text>
          <Text style={[styles.statLabel, { color: theme.muted }]}>blocked on this page</Text>
        </View>
        <View style={[styles.stat, { backgroundColor: theme.background }]}>
          <Text style={[styles.statValue, { color: theme.text }]}>{totalBlocked.toLocaleString()}</Text>
          <Text style={[styles.statLabel, { color: theme.muted }]}>blocked in total</Text>
        </View>
      </View>

      <Text style={[styles.note, { color: theme.muted }]}>
        If this site doesn't work properly, turn protection off. It's remembered for {site || 'this site'}.
      </Text>
      <Row title="Settings" icon="sliders" theme={theme} onPress={onOpenSettings} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 10 },
  site: { fontSize: 18, fontWeight: '600' },
  stats: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  stat: { flex: 1, borderRadius: 14, padding: 14 },
  statValue: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 13, marginTop: 2 },
  note: { fontSize: 13, paddingHorizontal: 18, paddingVertical: 8, lineHeight: 18 },
});
