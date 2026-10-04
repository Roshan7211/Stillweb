import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { describeLoadError, type LoadError } from '../../browser/loadErrors';
import { displayHost } from '../../browser/url';
import type { Theme } from '../theme';
import { Icon } from './primitives';

type Props = {
  theme: Theme;
  error: LoadError;
  canGoBack: boolean;
  onRetry: () => void;
  onBack: () => void;
  onSearch: (query: string) => void;
  /** Space the browser's bars cover at the top and bottom (edge-to-edge layout). */
  insets?: { top: number; bottom: number };
};

/** Stillweb's page for a site that couldn't be loaded, with the next steps that fit the problem. */
export default function LoadErrorPage({ theme, error, canGoBack, onRetry, onBack, onSearch, insets }: Props) {
  const info = describeLoadError(error);
  const host = displayHost(error.url);
  const secondary = { backgroundColor: theme.surface };
  return (
    <ScrollView
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.background }]}
      contentContainerStyle={[styles.content, insets && { paddingTop: 32 + insets.top, paddingBottom: 32 + insets.bottom }]}
      accessibilityRole="alert">
      <View style={[styles.badge, { backgroundColor: theme.surface }]}>
        <Icon name={info.icon} size={34} color={theme.muted} />
      </View>
      <Text style={[styles.title, { color: theme.text }]}>{info.title}</Text>
      <Text style={[styles.body, { color: theme.muted }]}>{info.body}</Text>

      <View style={styles.buttons}>
        <Pressable onPress={onRetry} style={[styles.button, { backgroundColor: theme.accent }]} accessibilityRole="button">
          <Text style={styles.primaryText}>{info.kind === 'crashed' ? 'Reload page' : 'Try again'}</Text>
        </Pressable>
        {info.canSearch && host ? (
          <Pressable onPress={() => onSearch(host)} style={[styles.button, secondary]} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: theme.text }]}>Search instead</Text>
          </Pressable>
        ) : null}
        {info.canOpenSettings ? (
          <Pressable onPress={() => Linking.openSettings().catch(() => {})} style={[styles.button, secondary]} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: theme.text }]}>Open Settings</Text>
          </Pressable>
        ) : null}
        {canGoBack ? (
          <Pressable onPress={onBack} style={[styles.button, secondary]} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: theme.text }]}>Go back</Text>
          </Pressable>
        ) : null}
      </View>

      {/* For support and the curious: what the system reported. */}
      <Text style={[styles.detail, { color: theme.muted }]} selectable>
        {error.url ? `${error.url}\n` : ''}Error {error.code}
        {error.description ? ` · ${error.description}` : ''}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  badge: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title: { fontSize: 21, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 360 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 14 },
  button: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
  primaryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  secondaryText: { fontWeight: '600', fontSize: 15 },
  detail: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 28, opacity: 0.8 },
});
