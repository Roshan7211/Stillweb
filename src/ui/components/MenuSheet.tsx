import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Theme } from '../theme';
import { Icon, Row, Sheet, type IconName } from './primitives';

export type MenuAction =
  | 'newTab'
  | 'newPrivateTab'
  | 'bookmarks'
  | 'history'
  | 'downloads'
  | 'settings'
  | 'toggleBookmark'
  | 'reader'
  | 'find'
  | 'share'
  | 'listen'
  | 'quit';

type Props = {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  hasPage: boolean;
  bookmarked: boolean;
  readerActive: boolean;
  showQuit: boolean;
  clearsOnQuit: boolean;
  onAction: (action: MenuAction) => void;
};

export default function MenuSheet({ visible, onClose, theme, hasPage, bookmarked, readerActive, showQuit, clearsOnQuit, onAction }: Props) {
  const quick: { action: MenuAction; icon: IconName; label: string; active?: boolean }[] = [
    { action: 'toggleBookmark', icon: 'star', label: bookmarked ? 'Saved' : 'Bookmark', active: bookmarked },
    { action: 'reader', icon: 'book-open', label: readerActive ? 'Exit reader' : 'Reader', active: readerActive },
    { action: 'listen', icon: 'headphones', label: 'Listen' },
    { action: 'find', icon: 'search', label: 'Find' },
    { action: 'share', icon: 'share-2', label: 'Share' },
  ];

  return (
    <Sheet visible={visible} onClose={onClose} theme={theme}>
      <View style={styles.quick}>
        {quick.map((q) => {
          const color = q.active ? theme.accent : theme.text;
          return (
            <Pressable
              key={q.action}
              disabled={!hasPage}
              onPress={() => onAction(q.action)}
              accessibilityRole="button"
              accessibilityLabel={q.label}
              style={({ pressed }) => [
                styles.quickButton,
                { backgroundColor: theme.background, opacity: !hasPage ? 0.35 : pressed ? 0.6 : 1 },
              ]}>
              <Icon name={q.icon} size={22} color={color} />
              <Text style={[styles.quickLabel, { color }]} numberOfLines={1}>
                {q.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView>
        <Row title="New tab" icon="plus" theme={theme} onPress={() => onAction('newTab')} />
        <Row title="New private tab" icon="eye-off" theme={theme} onPress={() => onAction('newPrivateTab')} />
        <Row title="Bookmarks" icon="bookmark" theme={theme} onPress={() => onAction('bookmarks')} />
        <Row title="History" icon="clock" theme={theme} onPress={() => onAction('history')} />
        <Row title="Downloads" icon="download" theme={theme} onPress={() => onAction('downloads')} />
        <Row title="Settings" icon="settings" theme={theme} onPress={() => onAction('settings')} />
        {showQuit ? (
          <Row
            title={clearsOnQuit ? 'Quit and clear data' : 'Quit'}
            icon="power"
            theme={theme}
            danger={clearsOnQuit}
            onPress={() => onAction('quit')}
          />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  quick: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  quickButton: { flex: 1, maxWidth: 76, height: 66, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 4 },
  quickLabel: { fontSize: 11, fontWeight: '500' },
});
