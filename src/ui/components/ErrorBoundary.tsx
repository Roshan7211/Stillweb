import { Component, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { onAppError } from '../../errors';
import type { Theme } from '../theme';
import { Icon, type IconName } from './primitives';

type BoundaryProps = {
  children: ReactNode;
  /** What to show instead of the part that failed; `reset` draws it again. */
  fallback: (reset: () => void, error: Error) => ReactNode;
};

/** Catches errors while drawing its part of the app, so one screen failing doesn't close Stillweb. */
export class ErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    return this.state.error ? this.props.fallback(this.reset, this.state.error) : this.props.children;
  }
}

type Action = { label: string; onPress: () => void };

/** Stillweb's page for something that went wrong inside the app. */
export function ProblemScreen({
  theme,
  icon = 'alert-octagon',
  title,
  body,
  primary,
  secondary,
}: {
  theme: Theme;
  icon?: IconName;
  title: string;
  body: string;
  primary: Action;
  secondary?: Action;
}) {
  return (
    <View style={[styles.problem, { backgroundColor: theme.background }]} accessibilityRole="alert">
      <View style={[styles.badge, { backgroundColor: theme.surface }]}>
        <Icon name={icon} size={34} color={theme.muted} />
      </View>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.body, { color: theme.muted }]}>{body}</Text>
      <View style={styles.buttons}>
        <Pressable onPress={primary.onPress} style={[styles.button, { backgroundColor: theme.accent }]} accessibilityRole="button">
          <Text style={styles.primaryText}>{primary.label}</Text>
        </Pressable>
        {secondary ? (
          <Pressable onPress={secondary.onPress} style={[styles.button, { backgroundColor: theme.surface }]} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: theme.text }]}>{secondary.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Notice for errors outside drawing (a tap or timer that failed): the app keeps running. */
export function ErrorNotice({ theme, onRestart }: { theme: Theme; onRestart: () => void }) {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onAppError(() => {
      setVisible(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 8000);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;
  return (
    <View style={[styles.notice, { top: insets.top + 8, backgroundColor: theme.dark ? '#ECEDEF' : '#25272B' }]} accessibilityRole="alert">
      <Text style={[styles.noticeText, { color: theme.dark ? '#16171A' : '#FFFFFF' }]}>
        Something didn’t work. Stillweb kept running; try again, or restart if things look wrong.
      </Text>
      <View style={styles.noticeButtons}>
        <Pressable onPress={() => setVisible(false)} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.noticeAction, { color: theme.dark ? '#16171A' : '#FFFFFF' }]}>Dismiss</Text>
        </Pressable>
        <Pressable onPress={onRestart} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.noticeAction, { color: theme.accent }]}>Restart</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  problem: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  badge: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title: { fontSize: 21, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 360 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 14 },
  button: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
  primaryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  secondaryText: { fontWeight: '600', fontSize: 15 },
  notice: {
    position: 'absolute',
    left: 12,
    right: 12,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    zIndex: 100,
    elevation: 100,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  noticeText: { fontSize: 14, lineHeight: 19 },
  noticeButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 22 },
  noticeAction: { fontSize: 15, fontWeight: '600' },
});
