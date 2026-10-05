import { StyleSheet, Switch, Text, View } from 'react-native';

import { useBlockedTotal } from '../../browser/blockedTotal';
import { useSettings } from '../../browser/settings';
import { usePlus } from '../../plus/plus';
import { siteKey } from '../../browser/url';
import type { Theme } from '../theme';
import { Icon, IconButton, Row, Sheet, SwitchRow } from './primitives';

type Props = {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  url: string;
  blocked: number;
  /** Reload so the new shield state takes effect. */
  onChanged: () => void;
  onOpenSettings: () => void;
  onOpenReport: () => void;
  /** A Plus switch was used without Plus. */
  onOpenPlus: () => void;
};

export default function ShieldPanel({
  visible,
  onClose,
  theme,
  url,
  blocked,
  onChanged,
  onOpenSettings,
  onOpenReport,
  onOpenPlus,
}: Props) {
  const { settings, setSiteShields, setSiteFix } = useSettings();
  const plus = usePlus();
  const totalBlocked = useBlockedTotal();
  const site = siteKey(url);
  const globallyOn = settings.shields.enabled;
  const siteOn = globallyOn && !settings.disabledSites.includes(site);
  const fix = settings.siteFixes[site] ?? {};
  const hiddenCount = fix.hidden?.length ?? 0;

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
        If this site doesn’t work properly, turn protection off. It’s remembered for {site || 'this site'}.
      </Text>
      {site ? (
        <>
          <SwitchRow
            title="Desktop website"
            value={!!fix.desktop}
            onValueChange={(v) => {
              setSiteFix(site, { desktop: v });
              onChanged();
            }}
            theme={theme}
          />
          <SwitchRow
            title={plus.unlocked ? 'JavaScript' : 'JavaScript · Plus'}
            subtitle="Turn off for a site that keeps showing pop-ups or won't stop moving"
            value={plus.unlocked ? !fix.noScript : true}
            onValueChange={(v) => {
              if (!plus.unlocked) return onOpenPlus();
              setSiteFix(site, { noScript: !v });
              onChanged();
            }}
            theme={theme}
          />
          {hiddenCount > 0 && plus.unlocked ? (
            <Row
              title={`${hiddenCount} hidden element${hiddenCount === 1 ? '' : 's'}`}
              subtitle="Elements you hid on this site"
              icon="eye-off"
              theme={theme}
              right={
                <IconButton
                  name="rotate-ccw"
                  label="Show hidden elements again"
                  color={theme.accent}
                  onPress={() => {
                    setSiteFix(site, { hidden: [] });
                    onChanged();
                  }}
                />
              }
            />
          ) : null}
        </>
      ) : null}
      <Row title="Privacy report" icon="bar-chart-2" theme={theme} onPress={onOpenReport} />
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
