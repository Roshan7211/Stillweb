import { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useLibrary } from '../../browser/library';
import { displayHost, displayUrl, isBlank } from '../../browser/url';
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
  /** Bumped to focus the field (e.g. new tab). */
  focusKey: number;
  onSubmit: (text: string) => void;
  onShieldPress: () => void;
  onReload: () => void;
  onStop: () => void;
  onFocusChange?: (focused: boolean) => void;
};

export default function AddressBar(props: Props) {
  const { theme, url, incognito, loading, progress, secure, shieldsActive, blocked, focusKey } = props;
  const library = useLibrary();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');

  // Not editing, the bar is plain text: Android can't hand it focus when a web view
  // loses focus. It becomes an input only when the user (or focusKey) asks for it.
  const startEditing = () => {
    setText(isBlank(url) ? '' : url);
    setFocused(true);
    props.onFocusChange?.(true);
  };

  useEffect(() => {
    if (focusKey > 0) startEditing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // Android's back key hides the keyboard but leaves the field focused; treat that as done.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => input.current?.blur());
    return () => sub.remove();
  }, []);

  const onBlur = () => {
    setFocused(false);
    props.onFocusChange?.(false);
  };

  const submit = (value: string) => {
    if (!value.trim()) return;
    input.current?.blur();
    Keyboard.dismiss();
    props.onSubmit(value);
  };

  // Private tabs never surface history in suggestions.
  const suggestions = focused && text && text !== url ? library.suggest(text).filter((s) => !incognito || s.kind === 'bookmark') : [];
  const bar = incognito ? theme.privateSurface : theme.surface;
  const fg = incognito ? '#ECE6F7' : theme.text;
  const muted = incognito ? '#B3A8CC' : theme.muted;

  return (
    <View style={styles.wrap}>
      <View style={[styles.bar, { backgroundColor: bar }]}>
        {focused ? (
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

        {!focused ? (
          <Pressable style={styles.display} onPress={startEditing} accessibilityRole="button" accessibilityLabel="Search or enter address">
            <Text style={[styles.displayText, { color: isBlank(url) ? muted : fg }]} numberOfLines={1}>
              {isBlank(url) ? (incognito ? 'Search privately or enter address' : 'Search or enter address') : displayHost(url)}
            </Text>
          </Pressable>
        ) : (
        <TextInput
          ref={input}
          autoFocus
          style={[styles.input, { color: fg }]}
          value={text}
          onChangeText={setText}
          onBlur={onBlur}
          onSubmitEditing={(e) => submit(e.nativeEvent.text)}
          selectTextOnFocus
          placeholder={incognito ? 'Search privately or enter address' : 'Search or enter address'}
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          inputMode="url"
          accessibilityLabel="Address"
        />
        )}

        {!focused && !isBlank(url) && secure ? <Icon name="lock" size={13} color={muted} /> : null}
        {focused ? (
          text ? <IconButton name="x" label="Clear" size={18} color={muted} onPress={() => setText('')} /> : null
        ) : !isBlank(url) ? (
          <IconButton
            name={loading ? 'x' : 'rotate-cw'}
            label={loading ? 'Stop' : 'Reload'}
            size={18}
            color={muted}
            onPress={loading ? props.onStop : props.onReload}
          />
        ) : null}
      </View>

      {loading && progress > 0 && progress < 1 ? (
        <View style={[styles.progress, { width: `${Math.max(progress, 0.08) * 100}%`, backgroundColor: theme.accent }]} />
      ) : (
        <View style={styles.progressSpacer} />
      )}

      {suggestions.length > 0 ? (
        <View style={[styles.suggestions, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <FlatList
            keyboardShouldPersistTaps="handled"
            data={suggestions}
            keyExtractor={(item) => item.url}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: theme.accentSoft }]}
                onPress={() => submit(item.url)}>
                <Icon name={item.kind === 'bookmark' ? 'star' : 'clock'} size={16} color={theme.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontSize: 15 }} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.muted, fontSize: 12 }} numberOfLines={1}>
                    {displayUrl(item.url)}
                  </Text>
                </View>
              </Pressable>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingTop: 6, zIndex: 10 },
  bar: { flexDirection: 'row', alignItems: 'center', height: 44, borderRadius: 22, paddingRight: 2 },
  leading: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 14, paddingRight: 6, height: 44 },
  count: { fontSize: 12, fontWeight: '700' },
  input: { flex: 1, fontSize: 16, paddingVertical: 0, height: 44 },
  display: { flex: 1, height: 44, justifyContent: 'center' },
  displayText: { fontSize: 16 },
  progress: { height: 2, marginTop: 4, borderRadius: 1 },
  progressSpacer: { height: 6 },
  suggestions: {
    position: 'absolute',
    top: 54,
    left: 10,
    right: 10,
    maxHeight: 320,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
});
