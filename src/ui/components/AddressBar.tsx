import { useEffect, useRef, useState } from 'react';
import { Animated, Keyboard, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { displayHost, isBlank } from '../../browser/url';
import type { Theme } from '../theme';
import { Icon, IconButton } from './primitives';

type Props = {
  theme: Theme;
  url: string;
  incognito: boolean;
  loading: boolean;
  progress: number;
  secure: boolean;
  shieldsActive: boolean;
  blocked: number;
  /** Where the bar sits; the progress line goes on the edge facing the page. */
  position: 'top' | 'bottom';
  editing: boolean;
  /** Text being edited (owned by the screen, which shows suggestions for it). */
  text: string;
  onChangeText: (text: string) => void;
  onStartEditing: () => void;
  onEndEditing: () => void;
  onSubmit: (text: string) => void;
  onShieldPress: () => void;
  onReload: () => void;
  onStop: () => void;
  /** Horizontal swipe on the bar: next (swipe left) or previous (swipe right) tab. */
  onSwipe?: (direction: 'next' | 'previous') => void;
  /** Sits between buttons in the single bottom bar (no side margins of its own). */
  inline?: boolean;
};

export default function AddressBar(props: Props) {
  const { theme, url, incognito, loading, progress, secure, shieldsActive, blocked, position, editing, text } = props;
  const input = useRef<TextInput>(null);

  // Swiping the bar sideways switches tabs, with the bar following the finger. The gesture
  // handler must outlive re-renders (page progress re-renders the bar mid-swipe), so it reads
  // the latest onSwipe from a ref, and only when a swipe ends.
  const onSwipe = useRef(props.onSwipe);
  useEffect(() => {
    onSwipe.current = props.onSwipe;
  });
  const [shift] = useState(() => new Animated.Value(0));
  // eslint-disable-next-line react-hooks/refs
  const [swipe] = useState(() => {
    const settle = () => Animated.spring(shift, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    return PanResponder.create({
      // Only clearly sideways drags; taps still start editing.
      onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderMove: (_, g) => shift.setValue(g.dx * 0.6),
      onPanResponderRelease: (_, g) => {
        const direction = g.dx < -60 || g.vx < -0.6 ? 'next' : g.dx > 60 || g.vx > 0.6 ? 'previous' : null;
        if (direction) onSwipe.current?.(direction);
        settle();
      },
      onPanResponderTerminate: settle,
    });
  });

  // Android's back key hides the keyboard but leaves the field focused; treat that as done.
  useEffect(() => {
    if (Platform.OS !== 'android' || !editing) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => input.current?.blur());
    return () => sub.remove();
  }, [editing]);

  const submit = (value: string) => {
    if (!value.trim()) return;
    input.current?.blur();
    Keyboard.dismiss();
    props.onSubmit(value);
  };

  const bar = incognito ? theme.privateSurface : theme.surface;
  const fg = incognito ? '#ECE6F7' : theme.text;
  const muted = incognito ? '#B3A8CC' : theme.muted;
  const placeholder = incognito ? 'Search privately or enter address' : 'Search or enter address';
  const blank = isBlank(url);

  const progressLine =
    loading && progress > 0 && progress < 1 ? (
      <View style={[styles.progress, { width: `${Math.max(progress, 0.08) * 100}%`, backgroundColor: theme.accent }]} />
    ) : (
      <View style={styles.progressSpacer} />
    );

  return (
    <View style={[position === 'top' ? styles.wrapTop : styles.wrapBottom, props.inline && styles.inline]}>
      {position === 'bottom' ? progressLine : null}
      <Animated.View
        style={[styles.row, { transform: [{ translateX: shift }] }]}
        {...(editing || !props.onSwipe ? {} : swipe.panHandlers)}>
        <View style={[styles.bar, { backgroundColor: bar }]}>
          {editing ? (
            <View style={styles.leading}>
              <Icon name="search" size={18} color={muted} />
            </View>
          ) : (
            <Pressable
              onPress={props.onShieldPress}
              style={styles.leading}
              accessibilityRole="button"
              accessibilityLabel={shieldsActive ? `Protection on, ${blocked} blocked` : 'Protection off for this site'}>
              <Icon name={shieldsActive ? 'shield' : 'shield-off'} size={19} color={shieldsActive ? theme.accent : muted} />
              {shieldsActive && blocked > 0 ? (
                <Text style={[styles.count, { color: theme.accent }]}>{blocked > 999 ? '999+' : blocked}</Text>
              ) : null}
            </Pressable>
          )}

          {editing ? (
            <TextInput
              ref={input}
              autoFocus
              style={[styles.input, { color: fg }]}
              value={text}
              onChangeText={props.onChangeText}
              onBlur={props.onEndEditing}
              onSubmitEditing={(e) => submit(e.nativeEvent.text)}
              selectTextOnFocus
              placeholder={placeholder}
              placeholderTextColor={muted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              // iPhone's URL keyboard has no space bar, which makes searching painful; the
              // web-search keyboard has both space and ".", like Safari's address field.
              inputMode={Platform.OS === 'ios' ? 'search' : 'url'}
              returnKeyType="go"
              enablesReturnKeyAutomatically
              accessibilityLabel="Address"
            />
          ) : (
            <Pressable style={styles.display} onPress={props.onStartEditing} accessibilityRole="button" accessibilityLabel={placeholder}>
              {!blank && secure ? <Icon name="lock" size={12} color={muted} /> : null}
              <Text style={[styles.displayText, { color: blank ? muted : fg }]} numberOfLines={1}>
                {blank ? placeholder : displayHost(url)}
              </Text>
            </Pressable>
          )}

          {editing ? (
            text ? (
              <IconButton name="x" label="Clear" size={18} color={muted} onPress={() => props.onChangeText('')} />
            ) : null
          ) : !blank ? (
            <IconButton
              name={loading ? 'x' : 'rotate-cw'}
              label={loading ? 'Stop' : 'Reload'}
              size={18}
              color={muted}
              onPress={loading ? props.onStop : props.onReload}
            />
          ) : (
            // Keeps the address centered when there is no reload button.
            <View style={styles.trailingSpacer} />
          )}
        </View>
        {/* iPhone has no back key to leave the field, so offer Cancel like Safari does. */}
        {editing && Platform.OS === 'ios' ? (
          <Pressable
            onPress={() => {
              input.current?.blur();
              Keyboard.dismiss();
            }}
            style={styles.cancel}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel editing">
            <Text style={[styles.cancelText, { color: theme.accent }]}>Cancel</Text>
          </Pressable>
        ) : null}
      </Animated.View>
      {position === 'top' ? progressLine : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapTop: { paddingHorizontal: 10, paddingTop: 6 },
  wrapBottom: { paddingHorizontal: 10, paddingBottom: 4 },
  inline: { paddingHorizontal: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  bar: { flex: 1, flexDirection: 'row', alignItems: 'center', height: 44, borderRadius: Platform.OS === 'ios' ? 14 : 22, paddingRight: 2 },
  leading: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 12, paddingRight: 6, height: 44, minWidth: 44 },
  count: { fontSize: 12, fontWeight: '700' },
  input: { flex: 1, fontSize: 16, paddingVertical: 0, height: 44 },
  // Centered like Safari on iOS; start-aligned like Chrome on Android.
  display: {
    flex: 1,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: Platform.OS === 'ios' ? 'center' : 'flex-start',
    gap: 5,
  },
  displayText: { fontSize: 16, flexShrink: 1 },
  trailingSpacer: { width: 44 },
  cancel: { height: 44, justifyContent: 'center', paddingLeft: 12, paddingRight: 4 },
  cancelText: { fontSize: 16, fontWeight: '500' },
  progress: { height: 2, marginVertical: 2, borderRadius: 1 },
  progressSpacer: { height: 6 },
});
