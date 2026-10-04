import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SLEEP_CHOICES, SPEEDS, speedLabel, type SleepChoice } from '../../browser/listen';
import type { Theme } from '../theme';
import { Icon, Sheet } from './primitives';

/** The sleep timer that's running: until a time, or until the current audio or video ends. */
export type SleepState = { endsAt: number } | { endOfMedia: true } | null;

type Props = {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  rate: number;
  onRate: (rate: number) => void;
  sleep: SleepState;
  onSleep: (choice: SleepChoice | null) => void;
};

function Chip({ theme, label, active, onPress }: { theme: Theme; label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, { backgroundColor: active ? theme.accent : theme.background }]}>
      <Text style={[styles.chipText, { color: active ? '#FFFFFF' : theme.text }]}>{label}</Text>
    </Pressable>
  );
}

/** Listen Mode (Stillweb Plus): speed and sleep timer for whatever the page is playing. */
export default function ListenSheet({ visible, onClose, theme, rate, onRate, sleep, onSleep }: Props) {
  const status =
    sleep === null
      ? 'Off'
      : 'endOfMedia' in sleep
        ? 'Pauses when this audio or video ends'
        : `Pauses at ${new Date(sleep.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

  return (
    <Sheet visible={visible} onClose={onClose} theme={theme}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Icon name="headphones" size={22} color={theme.accent} />
          <Text style={[styles.title, { color: theme.text }]}>Listen</Text>
        </View>

        <Text style={[styles.label, { color: theme.muted }]}>Playback speed</Text>
        <View style={styles.chips}>
          {SPEEDS.map((s) => (
            <Chip key={s} theme={theme} label={speedLabel(s)} active={rate === s} onPress={() => onRate(s)} />
          ))}
        </View>

        <Text style={[styles.label, { color: theme.muted }]}>Sleep timer · {status}</Text>
        <View style={styles.chips}>
          {SLEEP_CHOICES.map((c) => (
            <Chip key={c.id} theme={theme} label={c.label} active={false} onPress={() => onSleep(c)} />
          ))}
          {sleep !== null ? <Chip theme={theme} label="Turn off" active={false} onPress={() => onSleep(null)} /> : null}
        </View>
        <Text style={[styles.note, { color: theme.muted }]}>
          Works for audio and video on the page, also with the screen locked or in another app.
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingBottom: 8, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 4 },
  title: { fontSize: 19, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  chipText: { fontSize: 15, fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 17, marginTop: 6 },
});
